import { randomUUID } from "node:crypto";
import { mapChatArticle, mapChatMessage, mapConversation } from "../db.js";
import {
  loadConversation,
  requireConversationWriteToken
} from "../prehandlers.js";
import {
  askArticleQuestionSchema,
  createArticleChatSchema,
  discoverArticleMediaSchema,
  getArticleChatSchema,
  listArticleChatsSchema
} from "../schemas.js";
import {
  createConversationToken
} from "../services/conversationTokenService.js";
import { validatePublicArticleUrl } from "../services/exaService.js";
import { normalizeQuestion, questionHash } from "../services/questionService.js";
import {
  retrieveArticleChunks,
  vectorLiteral
} from "../services/vectorSearchService.js";

const DIRECT_CONTEXT_MAX_CHARS = Number(
  process.env.DIRECT_CONTEXT_MAX_CHARS || 12_000
);
const RECENT_MESSAGE_LIMIT = 8;
const CURRENT_MEDIA_EXTRACTION_VERSION = 4;
const MAX_QUESTIONS = Number(process.env.CHAT_QUESTION_LIMIT || 20);
const SEMANTIC_DUPLICATE_THRESHOLD = Number(
  process.env.SEMANTIC_DUPLICATE_THRESHOLD || 0.90
);
const FALLBACK_QUESTIONS = [
  "What is the main idea in this article?",
  "How does the approach work in practice?",
  "What are the key limitations or trade-offs?"
];

async function findArticleByUrl(database, canonicalUrl) {
  const result = await database.query(
    `SELECT id, canonical_url, title, source_name, content, content_hash,
            processing_mode, suggested_questions, media_status,
            media_extraction_version, created_at
       FROM chat_articles
      WHERE canonical_url = $1`,
    [canonicalUrl]
  );
  return result.rows[0] ? mapChatArticle(result.rows[0]) : null;
}

async function ensureArticleChunks(fastify, article) {
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
      [article.id, chunk.index, chunk.content, vectorLiteral(chunk.embedding)]
    );
  }
}

async function storeMediaCandidates(database, articleId, extracted) {
  const candidates = [
    ...(extracted.imageUrls || []).map((url, index) => ["image", url, index + 1]),
    ...(extracted.videoUrls || []).slice(0, 4).map((url, index) => ["video", url, index + 1])
  ];
  for (const [type, url, sourceOrder] of candidates) {
    await database.query(
      `INSERT INTO article_media
         (article_id, media_type, source_url, source_order, status)
       VALUES ($1, $2, $3, $4, 'available')
       ON CONFLICT (article_id, source_url) DO UPDATE
         SET media_type = EXCLUDED.media_type,
             source_order = EXCLUDED.source_order,
             status = CASE
               WHEN article_media.status = 'analyzed' THEN 'analyzed'
               ELSE 'available'
             END,
             analysis = CASE
               WHEN article_media.status = 'analyzed' THEN article_media.analysis
               ELSE NULL
             END,
             analysis_text = CASE
               WHEN article_media.status = 'analyzed' THEN article_media.analysis_text
               ELSE NULL
             END,
             updated_at = NOW()`,
      [articleId, type, url, sourceOrder]
    );
  }
}

async function reconcileImageCandidates(database, articleId, imageUrls) {
  if (!imageUrls?.length) return;
  const allowed = new Set(imageUrls);
  const existing = await database.query(
    `SELECT id, source_url
       FROM article_media
      WHERE article_id = $1 AND media_type = 'image'`,
    [articleId]
  );
  for (const row of existing.rows) {
    if (allowed.has(row.source_url)) continue;
    await database.query(
      `UPDATE article_media
          SET status = 'ignored', updated_at = NOW()
        WHERE id = $1`,
      [row.id]
    );
  }
}

async function pendingMedia(database, articleId, type, limit) {
  const result = await database.query(
    `SELECT id, media_type, source_url
       FROM article_media
      WHERE article_id = $1 AND media_type = $2
        AND status IN ('available', 'pending')
      ORDER BY COALESCE(source_order, id), id
      LIMIT $3`,
    [articleId, type, limit]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    mediaType: row.media_type,
    url: row.source_url
  }));
}

async function analyzeRequestedVideo(fastify, article, question) {
  const items = await pendingMedia(fastify.db, article.id, "video", 1);
  for (const item of items) {
    try {
      const result = await fastify.ai.analyzeMedia({
        articleTitle: article.title,
        articleContext: article.content.slice(0, 8_000),
        question,
        items: [item]
      });
      for (const analysis of result.analyses) {
        const status = analysis.relevant ? "analyzed" : "ignored";
        const text = [
          analysis.description,
          analysis.relationToArticle,
          ...(analysis.keyDetails || [])
        ].filter(Boolean).join("\n");
        await fastify.db.query(
          `UPDATE article_media
              SET status = $2, analysis = $3::jsonb, analysis_text = $4,
                  updated_at = NOW()
            WHERE id = $1`,
          [analysis.id, status, JSON.stringify(analysis), text]
        );
      }
    } catch (error) {
      fastify.log.warn(
        { error, articleId: article.id, mediaId: item.id, type: "video" },
        "Media analysis failed"
      );
      await fastify.db.query(
        `UPDATE article_media
            SET status = 'failed', updated_at = NOW()
          WHERE id = $1`,
        [item.id]
      );
    }
  }
}

async function discoverArticleMedia(fastify, article) {
  const claimed = await fastify.db.query(
    `UPDATE chat_articles
        SET media_status = 'processing',
            media_processing_started_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND (
          media_status IN ('pending', 'failed')
          OR (
            media_status = 'processing'
            AND media_processing_started_at < NOW() - INTERVAL '5 minutes'
          )
        )
      RETURNING media_status`,
    [article.id]
  );
  if (claimed.rowCount === 0) {
    const current = await fastify.db.query(
      `SELECT media_status FROM chat_articles WHERE id = $1`,
      [article.id]
    );
    return {
      claimed: false,
      mediaStatus: current.rows[0]?.media_status || article.mediaStatus
    };
  }

  try {
    const discovered = await fastify.exa.discoverArticleMedia?.(
      article.canonicalUrl
    );
    if (discovered) {
      await storeMediaCandidates(fastify.db, article.id, discovered);
    }
    const mediaStatus = "ready";
    await fastify.db.query(
      `UPDATE chat_articles
          SET media_status = $2, media_processing_started_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [article.id, mediaStatus]
    );
    return { claimed: true, mediaStatus };
  } catch (error) {
    fastify.log.error({ error, articleId: article.id }, "Article media discovery failed");
    await fastify.db.query(
      `UPDATE chat_articles
          SET media_status = 'failed', media_processing_started_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [article.id]
    );
    return { claimed: true, mediaStatus: "failed" };
  }
}

async function ensureSuggestedQuestions(fastify, article) {
  if (article.suggestedQuestions?.length === 3) return article.suggestedQuestions;
  let questions = FALLBACK_QUESTIONS;
  try {
    const result = await fastify.ai.suggestQuestions({
      articleTitle: article.title,
      articleContext: article.content.slice(0, 10_000),
      mediaContext: ""
    });
    if (result.questions?.length === 3) questions = result.questions;
  } catch (error) {
    fastify.log.warn({ error, articleId: article.id }, "Question suggestions failed");
  }
  await fastify.db.query(
    `UPDATE chat_articles
        SET suggested_questions = $2::jsonb, updated_at = NOW()
      WHERE id = $1`,
    [article.id, JSON.stringify(questions)]
  );
  article.suggestedQuestions = questions;
  return questions;
}

function needsMetadataRefresh(article) {
  if (article.mediaExtractionVersion < CURRENT_MEDIA_EXTRACTION_VERSION) {
    return true;
  }
  const title = article.title.trim().toLowerCase();
  const source = article.sourceName.split(".")[0].toLowerCase();
  return ["article", "home", "medium", "substack", "untitled", source]
    .includes(title);
}

async function refreshCachedArticle(fastify, article) {
  const extracted = await fastify.exa.extractArticle(article.canonicalUrl);
  const processingMode = extracted.content.length <= DIRECT_CONTEXT_MAX_CHARS
    ? "direct"
    : "vector";
  const contentChanged = extracted.contentHash !== article.contentHash;
  await fastify.db.query(
    `UPDATE chat_articles
        SET title = $2, content = $3, content_hash = $4,
            processing_mode = $5, suggested_questions = '[]'::jsonb,
            media_status = 'pending', media_extraction_version = $6,
            media_processing_started_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [
      article.id,
      extracted.title,
      extracted.content,
      extracted.contentHash,
      processingMode,
      CURRENT_MEDIA_EXTRACTION_VERSION
    ]
  );
  if (contentChanged) {
    await fastify.db.query(
      `DELETE FROM article_chunks WHERE article_id = $1`,
      [article.id]
    );
  }
  await storeMediaCandidates(fastify.db, article.id, extracted);
  await reconcileImageCandidates(
    fastify.db,
    article.id,
    extracted.imageUrls
  );
  Object.assign(article, {
    title: extracted.title,
    content: extracted.content,
    contentHash: extracted.contentHash,
    processingMode,
    suggestedQuestions: [],
    mediaStatus: "pending",
    mediaExtractionVersion: CURRENT_MEDIA_EXTRACTION_VERSION
  });
}

async function loadOrCreateArticle(fastify, submittedUrl) {
  const canonicalUrl = validatePublicArticleUrl(submittedUrl);
  let article = await findArticleByUrl(fastify.db, canonicalUrl);
  if (article) {
    if (needsMetadataRefresh(article)) {
      await refreshCachedArticle(fastify, article);
    }
    await ensureArticleChunks(fastify, article);
    await ensureSuggestedQuestions(fastify, article);
    return article;
  }

  const extracted = await fastify.exa.extractArticle(canonicalUrl);
  const processingMode = extracted.content.length <= DIRECT_CONTEXT_MAX_CHARS
    ? "direct"
    : "vector";
  const inserted = await fastify.db.query(
    `INSERT INTO chat_articles
       (canonical_url, title, source_name, content, content_hash, processing_mode)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (canonical_url) DO NOTHING
     RETURNING id, canonical_url, title, source_name, content, content_hash,
               processing_mode, suggested_questions, media_status,
               media_extraction_version, created_at`,
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

  if (inserted.rows[0]) {
    await storeMediaCandidates(fastify.db, article.id, extracted);
  }
  await ensureArticleChunks(fastify, article);
  await ensureSuggestedQuestions(fastify, article);
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

async function retrieveEvidence(fastify, conversation, embedding) {
  if (conversation.article.processingMode === "direct") {
    return articleEvidence(conversation.article);
  }
  const chunks = await retrieveArticleChunks(
    fastify.db,
    conversation.article.id,
    embedding
  );
  return articleEvidence(conversation.article, chunks);
}

async function analyzeSelectedImage(fastify, conversation, selectedMedia, question) {
  try {
    const result = await fastify.ai.analyzeMedia({
      articleTitle: conversation.article.title,
      articleContext: conversation.article.content.slice(0, 8_000),
      question,
      items: [{
        id: selectedMedia.id,
        mediaType: selectedMedia.mediaType,
        url: selectedMedia.sourceUrl
      }]
    });
    const analysis = result.analyses.find((item) => (
      item.id === selectedMedia.id && item.relevant
    ));
    if (!analysis) return null;
    const excerpt = [
      analysis.description,
      analysis.relationToArticle,
      ...(analysis.keyDetails || [])
    ].filter(Boolean).join("\n");
    if (!excerpt) return null;
    return {
      id: `image-${selectedMedia.id}`,
      title: `${conversation.article.title} — selected image`,
      url: selectedMedia.sourceUrl,
      excerpt,
      sourceType: "image"
    };
  } catch (error) {
    fastify.log.warn(
      { error, mediaId: selectedMedia.id },
      "Selected image analysis failed; answering from other evidence"
    );
    return null;
  }
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
    sourceType: evidence.sourceType,
    ...(evidence.timestamp ? { timestamp: evidence.timestamp } : {})
  };
}

function citationsForAnswer(answer, evidence) {
  const requested = new Set(answer.usedEvidenceIds || []);
  return evidence
    .filter((item) => requested.has(item.id))
    .map(citationForEvidence);
}

async function findExactDuplicate(fastify, articleId, hash) {
  const result = await fastify.db.query(
    `SELECT q.id AS question_id, q.conversation_id, q.question_embedding,
            a.id, a.role, a.content, a.answer_mode, a.citations, a.created_at
       FROM chat_messages q
       JOIN conversations c ON c.id = q.conversation_id
       JOIN chat_articles ca ON ca.id = c.article_id
       JOIN chat_messages a ON a.reply_to_message_id = q.id
      WHERE ca.id = $1 AND ca.content_hash = (
              SELECT content_hash FROM chat_articles WHERE id = $1
            )
        AND q.role = 'user' AND q.question_hash = $2
      ORDER BY q.created_at DESC
      LIMIT 1`,
    [articleId, hash]
  );
  return result.rows[0] || null;
}

async function findSemanticDuplicate(
  fastify,
  articleId,
  embedding,
  selectedMediaId = null
) {
  const result = await fastify.db.query(
    `SELECT q.id AS question_id, q.conversation_id,
            1 - (q.question_embedding <=> $2::vector) AS similarity,
            a.id, a.role, a.content, a.answer_mode, a.citations, a.created_at
       FROM chat_messages q
       JOIN conversations c ON c.id = q.conversation_id
       JOIN chat_messages a ON a.reply_to_message_id = q.id
      WHERE c.article_id = $1 AND q.role = 'user'
        AND q.question_embedding IS NOT NULL
        AND q.selected_media_id IS NOT DISTINCT FROM $3::bigint
      ORDER BY q.question_embedding <=> $2::vector
      LIMIT 1`,
    [articleId, vectorLiteral(embedding), selectedMediaId]
  );
  const row = result.rows[0];
  return row && Number(row.similarity) >= SEMANTIC_DUPLICATE_THRESHOLD
    ? row
    : null;
}

async function saveExchange(
  fastify,
  conversationId,
  question,
  normalized,
  hash,
  embedding,
  selectedMediaId,
  answer,
  citations
) {
  const userResult = await fastify.db.query(
    `INSERT INTO chat_messages
       (conversation_id, role, content, normalized_question, question_hash,
        question_embedding, selected_media_id)
     VALUES ($1, 'user', $2, $3, $4, $5::vector, $6)
     RETURNING id`,
    [
      conversationId,
      question,
      normalized,
      hash,
      embedding ? vectorLiteral(embedding) : null,
      selectedMediaId
    ]
  );
  const questionId = Number(userResult.rows[0].id);
  const assistant = await fastify.db.query(
    `INSERT INTO chat_messages
       (conversation_id, role, content, answer_mode, citations,
        reply_to_message_id)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb, $5)
     RETURNING id, role, content, answer_mode, citations, reply_to_message_id,
               created_at`,
    [
      conversationId,
      answer.answer,
      answer.answerMode,
      JSON.stringify(citations),
      questionId
    ]
  );
  await fastify.db.query(
    `UPDATE conversations
        SET updated_at = NOW(), expires_at = NOW() + INTERVAL '3 days'
      WHERE id = $1`,
    [conversationId]
  );
  return mapChatMessage(assistant.rows[0]);
}

async function reuseAnswer(fastify, conversation, questionData, duplicate) {
  const answer = {
    answer: duplicate.content,
    answerMode: duplicate.answer_mode,
    usedEvidenceIds: []
  };
  if (duplicate.conversation_id === conversation.id) {
    return mapChatMessage(duplicate);
  }
  const storedEmbedding = Array.isArray(duplicate.question_embedding)
    ? duplicate.question_embedding
    : (
        typeof duplicate.question_embedding === "string"
          ? JSON.parse(duplicate.question_embedding)
          : null
      );
  return saveExchange(
    fastify,
    conversation.id,
    questionData.question,
    questionData.normalized,
    questionData.hash,
    questionData.embedding || storedEmbedding,
    questionData.selectedMediaId,
    answer,
    duplicate.citations || []
  );
}

async function closeOrRephrase(fastify, conversation, questionData, scope) {
  const closes = scope.action === "close";
  const answer = {
    answer: closes
      ? "This chat is limited to AI, machine learning, and concepts needed to understand the selected article. Because this question is outside that scope, this conversation has been closed."
      : "I could not confidently connect that question to AI or this article. Please rephrase it with the AI concept or article section you mean.",
    answerMode: "guardrail",
    usedEvidenceIds: []
  };
  const message = await saveExchange(
    fastify,
    conversation.id,
    questionData.question,
    questionData.normalized,
    questionData.hash,
    questionData.embedding,
    questionData.selectedMediaId,
    answer,
    []
  );
  if (closes) {
    await fastify.db.query(
      `UPDATE conversations
          SET status = 'closed_scope', closed_at = NOW(), closed_reason = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [conversation.id, scope.reasonCode]
    );
  }
  return {
    message,
    duplicate: false,
    conversationStatus: closes ? "closed_scope" : "active"
  };
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
    `UPDATE conversations SET summary = $2, updated_at = NOW() WHERE id = $1`,
    [conversation.id, summary.summary]
  );
}

export default async function articleChatRoutes(fastify) {
  fastify.get("/api/article-chats", {
    schema: listArticleChatsSchema
  }, async (request) => {
    const limit = Number(request.query.limit || 12);
    const offset = Number(request.query.offset || 0);
    const result = await fastify.db.query(
      `SELECT c.id, c.updated_at, c.expires_at,
              a.title AS article_title, a.source_name AS article_source,
              a.canonical_url AS article_url,
              first_exchange.question AS first_question,
              first_exchange.answer AS first_answer,
              (
                SELECT COUNT(*)::int
                  FROM chat_messages count_messages
                 WHERE count_messages.conversation_id = c.id
                   AND count_messages.role = 'user'
              ) AS question_count
         FROM conversations c
         JOIN chat_articles a ON a.id = c.article_id
         JOIN LATERAL (
           SELECT question.content AS question, answer.content AS answer
             FROM chat_messages question
             JOIN chat_messages answer
               ON answer.reply_to_message_id = question.id
              AND answer.role = 'assistant'
              AND answer.answer_mode <> 'guardrail'
            WHERE question.conversation_id = c.id
              AND question.role = 'user'
            ORDER BY question.created_at ASC, question.id ASC
            LIMIT 1
         ) first_exchange ON TRUE
        WHERE c.status = 'active'
          AND c.expires_at > NOW()
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
    );
    const hasMore = result.rows.length > limit;
    const chats = result.rows.slice(0, limit).map((row) => ({
      id: row.id,
      articleTitle: row.article_title,
      articleSource: row.article_source,
      articleUrl: row.article_url,
      firstQuestion: row.first_question,
      answerPreview: row.first_answer.slice(0, 240),
      questionCount: Number(row.question_count),
      updatedAt: row.updated_at,
      expiresAt: row.expires_at
    }));
    return { chats, hasMore };
  });

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
    const writeToken = createConversationToken();
    const result = await fastify.db.query(
      `INSERT INTO conversations (id, article_id, write_token_hash)
       VALUES ($1, $2, $3)
       RETURNING id, summary, status, closed_at, closed_reason, expires_at,
                 created_at, updated_at`,
      [id, article.id, writeToken.hash]
    );
    const row = result.rows[0];
    const conversation = mapConversation({
      conversation_id: row.id,
      can_write: true,
      summary: row.summary,
      status: row.status,
      closed_at: row.closed_at,
      closed_reason: row.closed_reason,
      expires_at: row.expires_at,
      conversation_created_at: row.created_at,
      conversation_updated_at: row.updated_at,
      article_id: article.id,
      canonical_url: article.canonicalUrl,
      title: article.title,
      source_name: article.sourceName,
      content: article.content,
      content_hash: article.contentHash,
      processing_mode: article.processingMode,
      suggested_questions: article.suggestedQuestions,
      media_status: article.mediaStatus,
      article_created_at: article.createdAt
    });
    return reply.code(201).send({
      conversation,
      writeToken: writeToken.token
    });
  });

  fastify.get("/api/article-chats/:conversationId", {
    schema: getArticleChatSchema,
    preHandler: loadConversation
  }, async (request) => ({ conversation: request.conversation }));

  fastify.post("/api/article-chats/:conversationId/media/discover", {
    schema: discoverArticleMediaSchema,
    preHandler: [loadConversation, requireConversationWriteToken],
    config: {
      rateLimit: {
        max: Number(
          process.env.ARTICLE_MEDIA_DISCOVERY_LIMIT
          || process.env.ARTICLE_MEDIA_PROCESS_LIMIT
          || 10
        ),
        timeWindow: "1 hour"
      }
    }
  }, async (request) => discoverArticleMedia(
    fastify,
    request.conversation.article
  ));

  fastify.post("/api/article-chats/:conversationId/messages", {
    schema: askArticleQuestionSchema,
    preHandler: [loadConversation, requireConversationWriteToken],
    config: {
      rateLimit: {
        max: Number(process.env.ARTICLE_CHAT_MESSAGE_LIMIT || 30),
        timeWindow: "1 hour"
      }
    }
  }, async (request, reply) => {
    const conversation = request.conversation;
    if (conversation.status !== "active") {
      return reply.code(409).send({
        message: "This conversation was closed by the AI-domain guardrail"
      });
    }
    if (
      conversation.messages.filter((message) => message.role === "user").length
      >= MAX_QUESTIONS
    ) {
      return reply.code(429).send({
        message: `This conversation has reached its ${MAX_QUESTIONS}-question limit`
      });
    }

    const question = request.body.question.trim();
    const selectedMediaId = request.body.selectedMediaId || null;
    const selectedMedia = selectedMediaId
      ? conversation.media.find((item) => (
          item.id === selectedMediaId
          && item.mediaType === "image"
          && ["available", "pending", "analyzed"].includes(item.status)
        ))
      : null;
    if (selectedMediaId && !selectedMedia) {
      return reply.code(400).send({
        message: "The selected image is not available for this article"
      });
    }
    const aiQuestion = selectedMedia
      ? `${question}\n\nThe user selected image-${selectedMedia.id} from the article. Focus the answer on that image.`
      : question;
    const normalized = normalizeQuestion(question);
    const hash = questionHash(
      selectedMedia ? `${question}\nselected-image:${selectedMedia.id}` : question
    );
    const questionData = {
      question,
      normalized,
      hash,
      embedding: null,
      selectedMediaId
    };
    const exact = await findExactDuplicate(
      fastify,
      conversation.article.id,
      hash
    );
    if (exact) {
      const message = await reuseAnswer(
        fastify,
        conversation,
        questionData,
        exact
      );
      return {
        message,
        duplicate: true,
        matchedQuestionId: Number(exact.question_id),
        conversationStatus: conversation.status
      };
    }

    const scopeInput = {
      question,
      articleTitle: conversation.article.title,
      articleContext: conversation.article.content.slice(0, 4_000),
      conversationSummary: conversation.summary,
      recentMessages: recentMessages(conversation),
      hasSelectedImage: Boolean(selectedMedia),
      selectedMediaId: selectedMedia?.id || null,
      selectedMediaType: selectedMedia?.mediaType || null,
      mediaAnalysisCompleted: false,
      selectedMediaAnalysis: ""
    };
    let scope = await fastify.ai.checkQuestionScope(scopeInput);
    let tailoredImageEvidence = null;
    if (!selectedMedia && scope.action === "inspect_media") {
      scope = {
        ...scope,
        allowed: false,
        action: "rephrase",
        reasonCode: "selected-image-required"
      };
    }
    if (selectedMedia && scope.action !== "close") {
      tailoredImageEvidence = await analyzeSelectedImage(
        fastify,
        conversation,
        selectedMedia,
        question
      );
      scope = await fastify.ai.checkQuestionScope({
        ...scopeInput,
        mediaAnalysisCompleted: true,
        selectedMediaAnalysis: tailoredImageEvidence?.excerpt.slice(0, 6_000)
          || "Image analysis did not identify usable technical content."
      });
      if (scope.action === "inspect_media") {
        scope = {
          ...scope,
          allowed: false,
          action: "rephrase",
          reasonCode: "image-scope-remains-unclear"
        };
      }
    }
    if (scope.action !== "continue") {
      return closeOrRephrase(fastify, conversation, questionData, scope);
    }
    const embedded = await fastify.ai.embedQuery(question);
    questionData.embedding = embedded.embedding;

    const semantic = await findSemanticDuplicate(
      fastify,
      conversation.article.id,
      embedded.embedding,
      selectedMediaId
    );
    if (semantic) {
      const message = await reuseAnswer(
        fastify,
        conversation,
        questionData,
        semantic
      );
      return {
        message,
        duplicate: true,
        matchedQuestionId: Number(semantic.question_id),
        conversationStatus: conversation.status
      };
    }

    if (scope.intent === "media") {
      await analyzeRequestedVideo(fastify, conversation.article, question);
    }

    const articleItems = await retrieveEvidence(
      fastify,
      conversation,
      embedded.embedding
    );
    let imageEvidence = tailoredImageEvidence ? [tailoredImageEvidence] : [];
    if (selectedMedia && !tailoredImageEvidence) {
      const analyzedImageEvidence = await analyzeSelectedImage(
        fastify,
        conversation,
        selectedMedia,
        question
      );
      if (analyzedImageEvidence) imageEvidence = [analyzedImageEvidence];
    }
    const evidence = [...articleItems, ...imageEvidence];
    const grade = await fastify.ai.gradeEvidence({
      question: aiQuestion,
      articleTitle: conversation.article.title,
      evidence
    });
    const supervised = await fastify.ai.superviseAnswer({
      question: aiQuestion,
      articleTitle: conversation.article.title,
      conversationSummary: conversation.summary,
      recentMessages: recentMessages(conversation),
      evidence,
      evidenceGrade: grade
    });
    const citations = citationsForAnswer(
      supervised.answer,
      supervised.evidence
    );
    const message = await saveExchange(
      fastify,
      conversation.id,
      question,
      normalized,
      hash,
      embedded.embedding,
      selectedMediaId,
      supervised.answer,
      citations
    );
    await maybeSummarize(
      fastify,
      conversation,
      question,
      supervised.answer
    );
    return {
      message,
      duplicate: false,
      conversationStatus: "active"
    };
  });
}
