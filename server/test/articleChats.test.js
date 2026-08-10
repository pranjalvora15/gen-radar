import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  createExaService,
  validatePublicArticleUrl
} from "../src/services/exaService.js";
import { vectorLiteral } from "../src/services/vectorSearchService.js";

const ARTICLE_URL = "https://example.com/technical-rag-article";
const ARTICLE_CONTENT = "A detailed technical article about retrieval. ".repeat(20);

class FakeChatDatabase {
  constructor() {
    this.article = null;
    this.conversations = new Map();
    this.messages = [];
    this.media = [];
    this.chunks = [];
    this.nextMessageId = 1;
  }

  async query(text, values = []) {
    if (text.includes("FROM chat_articles") && text.includes("canonical_url")) {
      return this.article?.canonical_url === values[0]
        ? { rowCount: 1, rows: [this.article] }
        : { rowCount: 0, rows: [] };
    }

    if (text.includes("INSERT INTO chat_articles")) {
      if (this.article) return { rowCount: 0, rows: [] };
      this.article = {
        id: 1,
        canonical_url: values[0],
        title: values[1],
        source_name: values[2],
        content: values[3],
        content_hash: values[4],
        processing_mode: values[5],
        suggested_questions: [],
        media_status: "pending",
        media_extraction_version: 4,
        created_at: new Date("2026-07-29T00:00:00Z")
      };
      return { rowCount: 1, rows: [this.article] };
    }

    if (text.includes("INSERT INTO conversations")) {
      const conversation = {
        id: values[0],
        article_id: Number(values[1]),
        write_token_hash: values[2],
        summary: "",
        status: "active",
        closed_at: null,
        closed_reason: null,
        expires_at: new Date("2099-08-01T00:00:00Z"),
        created_at: new Date("2026-07-29T00:00:00Z"),
        updated_at: new Date("2026-07-29T00:00:00Z")
      };
      this.conversations.set(conversation.id, conversation);
      return { rowCount: 1, rows: [conversation] };
    }

    if (text.includes("JOIN LATERAL")) {
      const rows = [...this.conversations.values()]
        .filter((conversation) => conversation.status === "active")
        .map((conversation) => {
          const question = this.messages.find((message) => (
            message.conversation_id === conversation.id
            && message.role === "user"
            && this.messages.some((answer) => (
              answer.reply_to_message_id === message.id
              && answer.answer_mode !== "guardrail"
            ))
          ));
          const answer = question && this.messages.find((message) => (
            message.reply_to_message_id === question.id
            && message.answer_mode !== "guardrail"
          ));
          if (!question || !answer) return null;
          return {
            id: conversation.id,
            updated_at: conversation.updated_at,
            expires_at: conversation.expires_at,
            article_title: this.article.title,
            article_source: this.article.source_name,
            article_url: this.article.canonical_url,
            first_question: question.content,
            first_answer: answer.content,
            question_count: this.messages.filter((message) => (
              message.conversation_id === conversation.id && message.role === "user"
            )).length
          };
        })
        .filter(Boolean)
        .slice(Number(values[1]), Number(values[1]) + Number(values[0]));
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM conversations c")) {
      const conversation = this.conversations.get(values[0]);
      if (!conversation) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          conversation_id: conversation.id,
          summary: conversation.summary,
          status: conversation.status,
          write_token_hash: conversation.write_token_hash,
          closed_at: conversation.closed_at,
          closed_reason: conversation.closed_reason,
          expires_at: conversation.expires_at,
          conversation_created_at: conversation.created_at,
          conversation_updated_at: conversation.updated_at,
          article_id: this.article.id,
          canonical_url: this.article.canonical_url,
          title: this.article.title,
          source_name: this.article.source_name,
          content: this.article.content,
          content_hash: this.article.content_hash,
          processing_mode: this.article.processing_mode,
          suggested_questions: this.article.suggested_questions,
          media_status: this.article.media_status,
          media_extraction_version: this.article.media_extraction_version,
          article_created_at: this.article.created_at
        }]
      };
    }

    if (text.includes("JOIN chat_messages a") && text.includes("question_hash")) {
      const question = this.messages.find(
        (message) => message.role === "user" && message.question_hash === values[1]
      );
      const answer = question && this.messages.find(
        (message) => message.reply_to_message_id === question.id
      );
      return answer
        ? {
            rowCount: 1,
            rows: [{
              question_id: question.id,
              conversation_id: question.conversation_id,
              question_embedding: question.question_embedding,
              ...answer
            }]
          }
        : { rowCount: 0, rows: [] };
    }

    if (text.includes("JOIN chat_messages a") && text.includes("question_embedding")) {
      return { rowCount: 0, rows: [] };
    }

    if (text.includes("INSERT INTO article_media")) {
      const existing = this.media.find((item) => (
        item.article_id === Number(values[0]) && item.source_url === values[2]
      ));
      if (existing) {
        existing.media_type = values[1];
        existing.source_order = Number(values[3]);
        existing.status = existing.status === "analyzed" ? "analyzed" : "available";
        return { rowCount: 1, rows: [] };
      }
      this.media.push({
        id: this.media.length + 1,
        article_id: Number(values[0]),
        media_type: values[1],
        source_url: values[2],
        source_order: Number(values[3]),
        status: "available",
        analysis: null,
        analysis_text: null
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("FROM article_media")) {
      if (text.includes("COUNT(*)")) {
        if (text.includes("AS analyzed")) {
          return {
            rowCount: 1,
            rows: [{
              analyzed: this.media.filter((item) => item.status === "analyzed").length,
              failed: this.media.filter((item) => item.status === "failed").length
            }]
          };
        }
        const count = this.media.filter((item) => item.status === "analyzed").length;
        return { rowCount: 1, rows: [{ count }] };
      }
      let rows = this.media.filter((item) => item.article_id === Number(values[0]));
      if (text.includes("media_type = $2") && text.includes("status IN")) {
        rows = rows.filter((item) => (
          item.media_type === values[1]
          && ["available", "pending"].includes(item.status)
        )).slice(0, Number(values[2]));
      }
      if (text.includes("status IN ('available', 'pending', 'analyzed')")) {
        rows = rows.filter((item) => (
          ["available", "pending", "analyzed"].includes(item.status)
        ));
      }
      return { rowCount: rows.length, rows };
    }

    if (text.includes("SELECT media_status FROM chat_articles")) {
      return { rowCount: 1, rows: [{ media_status: this.article.media_status }] };
    }

    if (text.includes("FROM chat_messages")) {
      const rows = this.messages.filter(
        (message) => message.conversation_id === values[0]
      );
      return { rowCount: rows.length, rows };
    }

    if (text.includes("INSERT INTO chat_messages") && text.includes("'user'")) {
      const message = {
        id: this.nextMessageId++,
        conversation_id: values[0],
        role: "user",
        content: values[1],
        normalized_question: values[2],
        question_hash: values[3],
        question_embedding: values[4],
        selected_media_id: values[5] || null,
        answer_mode: null,
        citations: [],
        created_at: new Date("2026-07-29T00:01:00Z")
      };
      this.messages.push(message);
      return { rowCount: 1, rows: [{ id: message.id }] };
    }

    if (text.includes("INSERT INTO chat_messages") && text.includes("'assistant'")) {
      const message = {
        id: this.nextMessageId++,
        conversation_id: values[0],
        role: "assistant",
        content: values[1],
        answer_mode: values[2],
        citations: JSON.parse(values[3]),
        reply_to_message_id: Number(values[4]),
        created_at: new Date("2026-07-29T00:01:01Z")
      };
      this.messages.push(message);
      return { rowCount: 1, rows: [message] };
    }

    if (text.includes("UPDATE conversations")) {
      if (text.includes("status = 'closed_scope'")) {
        const conversation = this.conversations.get(values[0]);
        conversation.status = "closed_scope";
        conversation.closed_reason = values[1];
        conversation.closed_at = new Date("2026-07-29T00:02:00Z");
      }
      return { rowCount: 1, rows: [] };
    }

    if (
      text.includes("UPDATE chat_articles")
      && text.includes("media_status = 'processing'")
      && text.includes("RETURNING media_status")
    ) {
      if (!["pending", "failed"].includes(this.article.media_status)) {
        return { rowCount: 0, rows: [] };
      }
      this.article.media_status = "processing";
      return { rowCount: 1, rows: [{ media_status: "processing" }] };
    }

    if (text.includes("UPDATE chat_articles") && text.includes("suggested_questions")) {
      this.article.suggested_questions = JSON.parse(values[1]);
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("UPDATE chat_articles") && text.includes("media_status = $2")) {
      this.article.media_status = values[1];
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("UPDATE chat_articles") && text.includes("media_status = 'failed'")) {
      this.article.media_status = "failed";
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("UPDATE article_media") && text.includes("status = $2")) {
      const item = this.media.find((candidate) => candidate.id === Number(values[0]));
      if (item) {
        item.status = values[1];
        item.analysis = JSON.parse(values[2]);
        item.analysis_text = values[3];
      }
      return { rowCount: item ? 1 : 0, rows: [] };
    }

    if (text.includes("UPDATE article_media") && text.includes("status = 'failed'")) {
      const item = this.media.find((candidate) => candidate.id === Number(values[0]));
      if (item) item.status = "failed";
      return { rowCount: item ? 1 : 0, rows: [] };
    }

    if (text.includes("UPDATE article_media") && text.includes("status = 'ignored'")) {
      for (const item of this.media) {
        if (item.article_id === Number(values[0]) && item.status === "pending") {
          item.status = "ignored";
        }
      }
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("COUNT(*)") && text.includes("article_chunks")) {
      return { rowCount: 1, rows: [{ count: this.chunks.length }] };
    }

    if (text.includes("INSERT INTO article_chunks")) {
      this.chunks.push({
        article_id: values[0],
        chunk_index: values[1],
        content: values[2],
        embedding: values[3]
      });
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

function fakeExa() {
  return {
    extractionCalls: 0,
    mediaDiscoveryCalls: 0,
    async extractArticle(url) {
      this.extractionCalls += 1;
      return {
        canonicalUrl: url,
        title: "A technical RAG article",
        sourceName: "example.com",
        content: ARTICLE_CONTENT,
        contentHash: "content-hash",
        imageUrls: [],
        videoUrls: []
      };
    },
    async discoverArticleMedia() {
      this.mediaDiscoveryCalls += 1;
      return { imageUrls: [], videoUrls: [] };
    },
    async search() {
      return [];
    }
  };
}

function fakeAi() {
  return {
    superviseCalls: 0,
    analyzeMediaCalls: 0,
    lastSuperviseInput: null,
    async checkQuestionScope() {
      return {
        allowed: true,
        domain: "AI",
        relation: "ai",
        confidence: "high",
        action: "continue",
        reasonCode: "ai-question",
        intent: "document"
      };
    },
    async gradeEvidence() {
      return {
        sufficient: true,
        researchRequired: false,
        confidence: "high",
        reasonCode: "article-supported",
        missingInformation: [],
        searchQueries: []
      };
    },
    async superviseAnswer(input) {
      this.superviseCalls += 1;
      this.lastSuperviseInput = input;
      const selectedImage = input.evidence.find((item) => item.sourceType === "image");
      return {
        answer: {
          answer: selectedImage
            ? "The selected image shows retrieval before generation."
            : "The article explains retrieval before generation.",
          answerMode: selectedImage ? "media" : "article",
          usedEvidenceIds: [selectedImage?.id || "article-0"]
        },
        evidence: input.evidence
      };
    },
    async suggestQuestions() {
      return {
        questions: [
          "What is the main idea?",
          "How does it work?",
          "What are the limitations?"
        ]
      };
    },
    async analyzeMedia(input) {
      this.analyzeMediaCalls += 1;
      return {
        analyses: input.items.map((item) => ({
          id: item.id,
          mediaType: item.mediaType,
          relevant: true,
          description: "A retrieval architecture diagram.",
          relationToArticle: "It illustrates the article workflow.",
          keyDetails: ["Retriever", "Generator"],
          timestamps: []
        }))
      };
    },
    async summarizeConversation() {
      return { summary: "Conversation summary" };
    },
    async embedDocuments() {
      return {
        chunks: [{ index: 0, content: ARTICLE_CONTENT, embedding: [0.1, 0.2] }]
      };
    },
    async embedQuery() {
      return { embedding: [0.1, 0.2] };
    }
  };
}

async function createTestApp(aiService = fakeAi()) {
  const database = new FakeChatDatabase();
  const exaService = fakeExa();
  const app = await buildApp({
    database,
    exaService,
    aiService,
    logger: false
  });
  return { app, database, exaService, aiService };
}

test("private article URLs are rejected", () => {
  assert.throws(
    () => validatePublicArticleUrl("http://127.0.0.1:8000/private"),
    /Private-network/
  );
  assert.equal(
    validatePublicArticleUrl("https://example.com/post?utm_source=test"),
    "https://example.com/post"
  );
});

test("Medium extraction replaces a generic title and removes non-image links", async () => {
  const service = createExaService({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      if (String(url).includes("/feed/")) {
        return {
          ok: true,
          async text() {
            return `<?xml version="1.0"?><rss><channel><item>
              <title><![CDATA[Graph-Compressed Embeddings: A RAG Storage Idea]]></title>
              <guid>https://medium.com/@author/post-abcdef123456</guid>
              <content:encoded><![CDATA[
                <img src="https://cdn-images-1.medium.com/max/1024/article-diagram.png" />
                <img src="https://medium.com/_/stat?event=view" />
              ]]></content:encoded>
            </item></channel></rss>`;
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            results: [{
              title: "Medium",
              text: `${"Medium navigation ".repeat(20)}# Graph-Compressed Embeddings 6 min read ${"Article content ".repeat(30)}`,
              extras: {
                imageLinks: [
                  "https://medium.com/@author",
                  "https://miro.medium.com/v2/resize:fit:1358/format:webp/recommendation.png"
                ]
              }
            }]
          };
        }
      };
    }
  });
  const article = await service.extractArticle(ARTICLE_URL.replace(
    "example.com/technical-rag-article",
    "medium.com/@author/graph-compressed-embeddings-abcdef123456"
  ));

  assert.equal(article.title, "Graph-Compressed Embeddings: A RAG Storage Idea");
  assert.deepEqual(article.imageUrls, [
    "https://cdn-images-1.medium.com/max/1024/article-diagram.png"
  ]);
});

test("reader image discovery is deferred until after article extraction", async () => {
  const service = createExaService({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      if (String(url).startsWith("https://r.jina.ai/")) {
        return {
          ok: true,
          async text() {
            return `
              ![Architecture](https://contributor.example.com/wp-content/uploads/diagram.png)
              ![emoji](https://s.w.org/images/core/emoji/notebook.svg)
              ![Results table](https://contributor.example.com/wp-content/uploads/results.png)
            `;
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            results: [{
              title: "Loop Engineering for RAG Generation",
              text: "Readable article content ".repeat(30),
              extras: { imageLinks: [] }
            }]
          };
        }
      };
    }
  });

  const article = await service.extractArticle(
    "https://towardsdatascience.com/loop-engineering-for-rag-generation"
  );
  const media = await service.discoverArticleMedia(article.canonicalUrl);

  assert.deepEqual(article.imageUrls, []);
  assert.deepEqual(media.imageUrls, [
    "https://contributor.example.com/wp-content/uploads/diagram.png",
    "https://contributor.example.com/wp-content/uploads/results.png"
  ]);
});

test("vector literal rejects invalid values", () => {
  assert.equal(vectorLiteral([0.5, -0.25]), "[0.5,-0.25]");
  assert.throws(() => vectorLiteral([Number.NaN]));
});

test("creates a direct-context article chat and reuses the cached article", async (t) => {
  const { app, database, exaService, aiService } = await createTestApp();
  t.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(typeof first.json().writeToken, "string");
  assert.notEqual(
    first.json().writeToken,
    database.conversations.get(first.json().conversation.id)?.write_token_hash
  );
  assert.equal(first.json().conversation.article.processingMode, "direct");
  assert.equal(first.json().conversation.article.mediaStatus, "pending");
  assert.equal(exaService.extractionCalls, 1);
  assert.equal(aiService.analyzeMediaCalls, 0);
});

test("article images are discovered once without background AI analysis", async (t) => {
  const { app, database, aiService, exaService } = await createTestApp();
  t.after(() => app.close());
  exaService.discoverArticleMedia = async function discoverArticleMedia() {
    this.mediaDiscoveryCalls += 1;
    return {
      imageUrls: [
        "https://example.com/diagram-1.png",
        "https://example.com/diagram-2.png",
        "https://example.com/diagram-3.png"
      ],
      videoUrls: []
    };
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const conversationId = created.json().conversation.id;
  const writeToken = created.json().writeToken;
  const denied = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/media/discover`
  });
  const [first, second] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/api/article-chats/${conversationId}/media/discover`,
      headers: { "x-chat-token": writeToken }
    }),
    app.inject({
      method: "POST",
      url: `/api/article-chats/${conversationId}/media/discover`,
      headers: { "x-chat-token": writeToken }
    })
  ]);

  assert.equal(denied.statusCode, 403);
  assert.deepEqual(
    [first.json().claimed, second.json().claimed].sort(),
    [false, true]
  );
  assert.equal(aiService.analyzeMediaCalls, 0);
  assert.equal(exaService.mediaDiscoveryCalls, 1);
  assert.equal(database.article.media_status, "ready");
  assert.equal(database.media.length, 3);
  assert.deepEqual(database.media.map((item) => item.source_order), [1, 2, 3]);
  assert.equal(database.media.every((item) => item.status === "available"), true);
});

test("article question stores a grounded answer with an article citation", async (t) => {
  const { app, database } = await createTestApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const conversationId = created.json().conversation.id;
  const writeToken = created.json().writeToken;

  const denied = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    payload: { question: "How does retrieval work?" }
  });
  const invalidToken = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers: { "x-chat-token": "not-the-creator-token" },
    payload: { question: "How does retrieval work?" }
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers: { "x-chat-token": writeToken },
    payload: { question: "How does retrieval work?" }
  });

  assert.equal(denied.statusCode, 403);
  assert.equal(invalidToken.statusCode, 403);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().message.answerMode, "article");
  assert.equal(response.json().message.citations.length, 1);
  assert.equal(response.json().message.citations[0].sourceType, "article");

  const loaded = await app.inject({
    method: "GET",
    url: `/api/article-chats/${conversationId}`
  });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.json().conversation.canWrite, false);
  assert.equal(loaded.json().conversation.messages.length, 2);

  const ownerLoaded = await app.inject({
    method: "GET",
    url: `/api/article-chats/${conversationId}`,
    headers: { "x-chat-token": writeToken }
  });
  assert.equal(ownerLoaded.json().conversation.canWrite, true);
});

test("selected article image is validated, analyzed, and cited", async (t) => {
  const { app, database, aiService } = await createTestApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const conversationId = created.json().conversation.id;
  const headers = { "x-chat-token": created.json().writeToken };
  database.media.push({
    id: 9,
    article_id: 1,
    media_type: "image",
    source_url: "https://example.com/rag-diagram.png",
    source_order: 1,
    status: "available",
    analysis: { description: "A RAG workflow diagram." },
    analysis_text: "A RAG workflow diagram with retrieval and generation."
  });
  database.media.push({
    id: 10,
    article_id: 1,
    media_type: "image",
    source_url: "https://example.com/evaluation-chart.png",
    source_order: 2,
    status: "available",
    analysis: { description: "An evaluation results chart." },
    analysis_text: "An evaluation chart comparing model results."
  });

  const invalid = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers,
    payload: { question: "Explain this diagram", selectedMediaId: 99 }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(aiService.analyzeMediaCalls, 0);

  const response = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers,
    payload: { question: "Explain this diagram", selectedMediaId: 9 }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().message.answerMode, "media");
  assert.equal(response.json().message.citations[0].sourceType, "image");
  assert.equal(aiService.analyzeMediaCalls, 1);
  assert.equal(
    aiService.lastSuperviseInput.evidence.some((item) => item.id === "image-9"),
    true
  );

  const secondImage = await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers,
    payload: { question: "Explain this diagram", selectedMediaId: 10 }
  });
  assert.equal(secondImage.statusCode, 200);
  assert.equal(aiService.analyzeMediaCalls, 2);
  assert.equal(aiService.superviseCalls, 2);

  const loaded = await app.inject({
    method: "GET",
    url: `/api/article-chats/${conversationId}`
  });
  const selectedMediaIds = loaded.json().conversation.messages
    .filter((message) => message.role === "user")
    .map((message) => message.selectedMediaId);
  assert.deepEqual(selectedMediaIds, [9, 10]);
});

test("an exact repeated question reuses the stored answer without another AI answer", async (t) => {
  const { app, aiService } = await createTestApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const url = `/api/article-chats/${created.json().conversation.id}/messages`;
  const headers = { "x-chat-token": created.json().writeToken };

  const first = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { question: "How does retrieval work?" }
  });
  const repeated = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { question: "  HOW does retrieval work?  " }
  });

  assert.equal(first.statusCode, 200);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().duplicate, true);
  assert.equal(aiService.superviseCalls, 1);
});

test("an out-of-scope question closes the conversation", async (t) => {
  const aiService = fakeAi();
  aiService.checkQuestionScope = async () => ({
    allowed: false,
    domain: "health",
    relation: "unrelated",
    confidence: "high",
    action: "close",
    reasonCode: "outside-ai-domain",
    intent: "unclear"
  });
  const { app } = await createTestApp(aiService);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const url = `/api/article-chats/${created.json().conversation.id}/messages`;
  const headers = { "x-chat-token": created.json().writeToken };

  const closed = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { question: "How does human birth happen?" }
  });
  const afterClose = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { question: "What is RAG?" }
  });

  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().conversationStatus, "closed_scope");
  assert.equal(closed.json().message.answerMode, "guardrail");
  assert.equal(afterClose.statusCode, 409);
});

test("public chat list includes answered chats and hides empty or closed chats", async (t) => {
  const { app, database } = await createTestApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/article-chats",
    payload: { url: ARTICLE_URL }
  });
  const conversationId = created.json().conversation.id;

  const emptyList = await app.inject({
    method: "GET",
    url: "/api/article-chats?limit=12&offset=0"
  });
  assert.equal(emptyList.statusCode, 200);
  assert.equal(emptyList.json().chats.length, 0);

  await app.inject({
    method: "POST",
    url: `/api/article-chats/${conversationId}/messages`,
    headers: { "x-chat-token": created.json().writeToken },
    payload: { question: "How does retrieval work?" }
  });
  const answeredList = await app.inject({
    method: "GET",
    url: "/api/article-chats?limit=12&offset=0"
  });
  assert.equal(answeredList.json().chats.length, 1);
  assert.equal(answeredList.json().chats[0].id, conversationId);
  assert.equal(answeredList.json().chats[0].questionCount, 1);

  database.conversations.get(conversationId).status = "closed_scope";
  const closedList = await app.inject({
    method: "GET",
    url: "/api/article-chats?limit=12&offset=0"
  });
  assert.equal(closedList.json().chats.length, 0);
});
