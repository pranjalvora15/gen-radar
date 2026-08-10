import { randomUUID } from "node:crypto";
import { mapChatArticle, mapChatMessage, mapConversation } from "../db.js";
import { loadConversation } from "../prehandlers.js";
import {
  askArticleQuestionSchema,
  createArticleChatSchema,
  getArticleChatSchema
} from "../schemas.js";
import { validatePublicArticleUrl } from "../services/exaService.js";
import {
  retrieveArticleChunks,
  vectorLiteral
} from "../services/vectorSearchService.js";

const DIRECT_CONTEXT_MAX_CHARS = Number(
  process.env.DIRECT_CONTEXT_MAX_CHARS || 12_000
);
const RECENT_MESSAGE_LIMIT = 8;

async function findArticleByUrl(database, canonicalUrl) {
  const result = await database.query(
    `SELECT id, canonical_url, title, source_name, content, content_hash,
            processing_mode, created_at
       FROM chat_articles
      WHERE canonical_url = $1`,
    [canonicalUrl]
  );
  return result.rows[0] ? mapChatArticle(result.rows[0]) : null;
}

async function ensureArticleChunks(fastify, article) {
  if (article.processingMode !== "vector") return;

  const existing = await fastify.db.query(
    `SELECT COUNT(*)::int AS count
       FROM article_chunks
      WHERE article_id = $1`,
    [article.id]
  );
  if (Number(existing.rows[0]?.count || 0) > 0) return;

  const embedded = await fastify.ai.embedDocuments({
    title: article.title,
    content: article.content
  });
  for (const chunk of embedded.chunks) {
    await fastify.db.query(
      `INSERT INTO article_chunks
         (article_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (article_id, chunk_index) DO NOTHING`,
      [
        article.id,
        chunk.index,
        chunk.content,
        vectorLiteral(chunk.embedding)
      ]
    );
  }
}

async function loadOrCreateArticle(fastify, submittedUrl) {
  const canonicalUrl = validatePublicArticleUrl(submittedUrl);
  let article = await findArticleByUrl(fastify.db, canonicalUrl);
  if (article) {
    await ensureArticleChunks(fastify, article);
    return article;
  }

  const extracted = await fastify.exa.extractArticle(canonicalUrl);
  const processingMode = (
    extracted.content.length <= DIRECT_CONTEXT_MAX_CHARS
      ? "direct"
      : "vector"
  );
  const inserted = await fastify.db.query(
    `INSERT INTO chat_articles
       (canonical_url, title, source_name, content, content_hash, processing_mode)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (canonical_url) DO NOTHING
     RETURNING id, canonical_url, title, source_name, content, content_hash,
               processing_mode, created_at`,
    [
      extracted.canonicalUrl,
      extracted.title,
      extracted.sourceName,
      extracted.content,
      extracted.contentHash,
      processingMode
    ]
  );

  article = inserted.rows[0]
    ? mapChatArticle(inserted.rows[0])
    : await findArticleByUrl(fastify.db, extracted.canonicalUrl);
  await ensureArticleChunks(fastify, article);
  return article;
}

function articleEvidence(article, chunks = []) {
  if (article.processingMode === "direct") {
    return [{
      id: "article-0",
      title: article.title,
      url: article.canonicalUrl,
      excerpt: article.content,
      sourceType: "article"
    }];
  }
  return chunks.map((chunk) => ({
    ...chunk,
    title: article.title,
    url: article.canonicalUrl
  }));
}

async function retrieveEvidence(fastify, conversation, question) {
  if (conversation.article.processingMode === "direct") {
    return articleEvidence(conversation.article);
  }
  const embedded = await fastify.ai.embedQuery(question);
  const chunks = await retrieveArticleChunks(
    fastify.db,
    conversation.article.id,
    embedded.embedding
  );
  return articleEvidence(conversation.article, chunks);
}

function recentMessages(conversation) {
  return conversation.messages.slice(-RECENT_MESSAGE_LIMIT).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function citationForEvidence(evidence) {
  return {
    title: evidence.title,
    url: evidence.url,
    excerpt: evidence.excerpt.slice(0, 600),
    sourceType: evidence.sourceType
  };
}

function citationsForAnswer(answer, evidence) {
  const requested = new Set(answer.usedEvidenceIds || []);
  return evidence
    .filter((item) => requested.has(item.id))
    .map(citationForEvidence);
}

async function generateAnswer(fastify, input) {
  return fastify.ai.answerQuestion({
    question: input.question,
    articleTitle: input.article.title,
    route: input.route,
    conversationSummary: input.conversation.summary,
    recentMessages: recentMessages(input.conversation),
    evidence: input.evidence,
    generalCandidate: input.generalCandidate || "",
    correction: input.correction || ""
  });
}

async function externalEvidence(fastify, question, route) {
  return fastify.exa.search(route.searchQuery || question);
}

async function answerByRoute(fastify, input) {
  const { route } = input;
  if (route.route === "insufficient") {
    return {
      answer: "I could not find enough reliable information to answer that question. Try asking about a specific part of the article or provide another source.",
      answerMode: "insufficient",
      usedEvidenceIds: []
    };
  }

  if (route.route === "article" || route.route === "general") {
    return generateAnswer(fastify, {
      ...input,
      route: route.route,
      evidence: route.route === "article" ? input.articleEvidence : []
    });
  }

  if (route.route === "web_search") {
    const webEvidence = await externalEvidence(
      fastify,
      input.question,
      route
    );
    return generateAnswer(fastify, {
      ...input,
      route: "web_search",
      evidence: webEvidence
    }).then((answer) => ({ answer, evidence: webEvidence }));
  }

  const [generalCandidate, webEvidence] = await Promise.all([
    generateAnswer(fastify, {
      ...input,
      route: "general",
      evidence: []
    }),
    externalEvidence(fastify, input.question, route)
  ]);
  const combined = await generateAnswer(fastify, {
    ...input,
    route: "combined",
    evidence: [...input.articleEvidence, ...webEvidence],
    generalCandidate: generalCandidate.answer
  });
  return {
    answer: combined,
    evidence: [...input.articleEvidence, ...webEvidence]
  };
}

async function maybeJudgeAnswer(fastify, input) {
  const needsJudge = (
    ["web_search", "combined"].includes(input.answer.answerMode)
    || input.route.confidence === "low"
  );
  if (!needsJudge) return input.answer;

  const judgment = await fastify.ai.judgeAnswer({
    question: input.question,
    answer: input.answer.answer,
    answerMode: input.answer.answerMode,
    evidence: input.evidence
  });
  if (judgment.decision === "pass") return input.answer;

  return generateAnswer(fastify, {
    question: input.question,
    article: input.article,
    conversation: input.conversation,
    route: input.answer.answerMode,
    evidence: input.evidence,
    correction: judgment.correction
  });
}

async function saveExchange(fastify, conversationId, question, answer, citations) {
  await fastify.db.query(
    `INSERT INTO chat_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
    [conversationId, question]
  );
  const assistant = await fastify.db.query(
    `INSERT INTO chat_messages
       (conversation_id, role, content, answer_mode, citations)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb)
     RETURNING id, role, content, answer_mode, citations, created_at`,
    [conversationId, answer.answer, answer.answerMode, JSON.stringify(citations)]
  );
  await fastify.db.query(
    `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
    [conversationId]
  );
  return mapChatMessage(assistant.rows[0]);
}

async function maybeSummarize(fastify, conversation, question, answer) {
  const messageCount = conversation.messages.length + 2;
  if (messageCount < 12 || messageCount % 6 !== 0) return;

  const summary = await fastify.ai.summarizeConversation({
    existingSummary: conversation.summary,
    messages: [
      ...recentMessages(conversation),
      { role: "user", content: question },
      { role: "assistant", content: answer.answer }
    ]
  });
  await fastify.db.query(
    `UPDATE conversations
        SET summary = $2, updated_at = NOW()
      WHERE id = $1`,
    [conversation.id, summary.summary]
  );
}

export default async function articleChatRoutes(fastify) {
  fastify.post("/api/article-chats", {
    schema: createArticleChatSchema,
    config: {
      rateLimit: {
        max: Number(process.env.ARTICLE_CHAT_CREATE_LIMIT || 10),
        timeWindow: "1 hour"
      }
    }
  }, async (request, reply) => {
    const article = await loadOrCreateArticle(fastify, request.body.url);
    const id = randomUUID();
    const result = await fastify.db.query(
      `INSERT INTO conversations (id, article_id)
       VALUES ($1, $2)
       RETURNING id, summary, created_at, updated_at`,
      [id, article.id]
    );
    const row = result.rows[0];
    const conversation = mapConversation({
      conversation_id: row.id,
      summary: row.summary,
      conversation_created_at: row.created_at,
      conversation_updated_at: row.updated_at,
      article_id: article.id,
      canonical_url: article.canonicalUrl,
      title: article.title,
      source_name: article.sourceName,
      content: article.content,
      content_hash: article.contentHash,
      processing_mode: article.processingMode,
      article_created_at: article.createdAt
    });
    return reply.code(201).send({ conversation });
  });

  fastify.get("/api/article-chats/:conversationId", {
    schema: getArticleChatSchema,
    preHandler: loadConversation
  }, async (request) => ({ conversation: request.conversation }));

  fastify.post("/api/article-chats/:conversationId/messages", {
    schema: askArticleQuestionSchema,
    preHandler: loadConversation,
    config: {
      rateLimit: {
        max: Number(process.env.ARTICLE_CHAT_MESSAGE_LIMIT || 60),
        timeWindow: "1 hour"
      }
    }
  }, async (request) => {
    const question = request.body.question.trim();
    const conversation = request.conversation;
    const articleEvidenceItems = await retrieveEvidence(
      fastify,
      conversation,
      question
    );
    const route = await fastify.ai.routeQuestion({
      question,
      articleTitle: conversation.article.title,
      conversationSummary: conversation.summary,
      recentMessages: recentMessages(conversation),
      evidence: articleEvidenceItems
    });
    const routed = await answerByRoute(fastify, {
      question,
      route,
      article: conversation.article,
      conversation,
      articleEvidence: articleEvidenceItems
    });
    const answer = routed.answer?.answer ? routed.answer : routed;
    const evidence = routed.evidence || (
      answer.answerMode === "article" ? articleEvidenceItems : []
    );
    const judged = await maybeJudgeAnswer(fastify, {
      question,
      route,
      answer,
      evidence,
      article: conversation.article,
      conversation
    });
    const citations = citationsForAnswer(judged, evidence);
    const message = await saveExchange(
      fastify,
      conversation.id,
      question,
      judged,
      citations
    );
    await maybeSummarize(fastify, conversation, question, judged);
    return { message };
  });
}
