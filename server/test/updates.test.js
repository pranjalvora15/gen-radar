import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  categorize,
  deduplicateCandidates,
  discoverCandidates,
  fetchJsonWithRateLimitRetry,
  filterExistingCandidates,
  loadDiscoveryCache,
  normalizeExaResult,
  normalizeText,
  normalizeUrl,
  rankCandidateBatches,
  saveDiscoveryCache,
  saveDiscoveredUpdates,
  selectLearningUpdates
} from "../src/services/learningFeedService.js";

const articleExplanation = {
  category: "rag",
  summary: "A grounded summary.",
  simpleExplanation: "A simple explanation.",
  problemSolved: "It grounds generated answers in retrieved evidence.",
  tradeOffs: ["Retrieval adds latency."],
  keyPoints: ["A key point"],
  limitations: [],
  keywords: ["RAG", "Retrieval", "Generation", "Context", "Reranking"]
};

const keywordExplanation = {
  keyword: "RAG",
  simpleDefinition: "Retrieval followed by generation.",
  relationToArticle: "The update uses retrieved context.",
  example: "Search docs before answering.",
  relatedConcepts: ["Retrieval"],
  prerequisites: []
};

function row(overrides = {}) {
  return {
    id: 1,
    source_url: "https://neo4j.com/blog/genai/update",
    source_title: "A useful GenAI update",
    source_name: "example.com",
    source_content: "The source article content.",
    source_snippet: "A short source snippet.",
    display_summary: "A complete display summary for this technical article.",
    source_published_at: null,
    discovered_at: new Date("2026-07-24T00:00:00Z"),
    category: "rag",
    explanation: null,
    explanation_status: "pending",
    keywords: [],
    ...overrides
  };
}

class FakeDatabase {
  constructor(update = row()) {
    this.update = update;
    this.keywordCache = new Map();
  }

  async query(text, values = []) {
    if (text.includes("FROM updates") && text.includes("WHERE id")) {
      return this.update && Number(values[0]) === Number(this.update.id)
        ? { rowCount: 1, rows: [this.update] }
        : { rowCount: 0, rows: [] };
    }

    if (text.includes("FROM updates") && text.includes("ORDER BY")) {
      return { rowCount: this.update ? 1 : 0, rows: this.update ? [this.update] : [] };
    }

    if (text.includes("explanation_status = 'generating'") && text.includes("RETURNING id")) {
      if (this.update.explanation_status === "generating") {
        return { rowCount: 0, rows: [] };
      }
      this.update.explanation_status = "generating";
      return { rowCount: 1, rows: [{ id: this.update.id }] };
    }

    if (text.includes("SET explanation = $2::jsonb")) {
      this.update.explanation = JSON.parse(values[1]);
      this.update.explanation_status = "ready";
      this.update.category = values[2];
      this.update.keywords = JSON.parse(values[3]);
      return { rowCount: 1, rows: [{ explanation: this.update.explanation }] };
    }

    if (text.includes("explanation_status = 'failed'")) {
      this.update.explanation_status = "failed";
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("SELECT explanation") && text.includes("keyword_explanations")) {
      const explanation = this.keywordCache.get(`${values[0]}:${values[1]}`);
      return explanation
        ? { rowCount: 1, rows: [{ explanation }] }
        : { rowCount: 0, rows: [] };
    }

    if (text.includes("INSERT INTO keyword_explanations")) {
      const key = `${values[0]}:${values[2]}`;
      if (!this.keywordCache.has(key)) {
        this.keywordCache.set(key, JSON.parse(values[3]));
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

function fakeAi() {
  return {
    articleCalls: 0,
    keywordCalls: 0,
    async explainArticle() {
      this.articleCalls += 1;
      return articleExplanation;
    },
    async explainKeyword() {
      this.keywordCalls += 1;
      return keywordExplanation;
    }
  };
}

async function appWith(update = row()) {
  const database = new FakeDatabase(update);
  const aiService = fakeAi();
  const feedRefreshService = {
    async checkAndTrigger() {
      return { refreshing: false, lastRefreshedAt: null, lastError: null };
    }
  };
  const app = await buildApp({
    database,
    aiService,
    feedRefreshService,
    logger: false
  });
  return { app, database, aiService };
}

test("health endpoint responds", async (t) => {
  const { app } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("feed returns the stored display summary and refresh metadata", async (t) => {
  const { app } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/updates" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().updates[0].displaySummary, row().display_summary);
  assert.deepEqual(response.json().feed, {
    refreshing: false,
    lastRefreshedAt: null,
    lastError: null
  });
});

test("route schema rejects an invalid id", async (t) => {
  const { app } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/updates/zero" });
  assert.equal(response.statusCode, 400);
});

test("loadUpdate returns 404 before the handler", async (t) => {
  const { app } = await appWith(null);
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/updates/99/explain" });
  assert.equal(response.statusCode, 404);
});

test("article cache hit skips the AI service", async (t) => {
  const { app, aiService } = await appWith(
    row({ explanation: articleExplanation, keywords: articleExplanation.keywords })
  );
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/updates/1/explain" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cached, true);
  assert.equal(aiService.articleCalls, 0);
});

test("first article click generates and stores one explanation", async (t) => {
  const { app, database, aiService } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/updates/1/explain" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cached, false);
  assert.equal(aiService.articleCalls, 1);
  assert.deepEqual(database.update.keywords, articleExplanation.keywords);
});

test("legacy article explanation is regenerated with the current contract", async (t) => {
  const legacyExplanation = {
    category: "rag",
    summary: "Old summary",
    simpleExplanation: "Old explanation",
    whyItMatters: "Old impact",
    keyPoints: ["Old point"],
    limitations: [],
    keywords: ["RAG", "Retrieval", "Generation", "Context", "Reranking"]
  };
  const { app, database, aiService } = await appWith(
    row({ explanation: legacyExplanation, keywords: legacyExplanation.keywords })
  );
  t.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/api/updates/1/explain" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cached, false);
  assert.equal(aiService.articleCalls, 1);
  assert.deepEqual(database.update.explanation, articleExplanation);
});

test("keyword route rejects a value outside the generated list", async (t) => {
  const { app, aiService } = await appWith(
    row({ explanation: articleExplanation, keywords: articleExplanation.keywords })
  );
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/updates/1/keywords/explain",
    payload: { keyword: "Not in this update" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(aiService.keywordCalls, 0);
});

test("keyword result is cached by normalized key", async (t) => {
  const { app, aiService } = await appWith(
    row({ explanation: articleExplanation, keywords: articleExplanation.keywords })
  );
  t.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/updates/1/keywords/explain",
    payload: { keyword: " RAG " }
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/updates/1/keywords/explain",
    payload: { keyword: "rag" }
  });

  assert.equal(first.statusCode, 200);
  assert.equal(first.json().cached, false);
  assert.equal(second.json().cached, true);
  assert.equal(aiService.keywordCalls, 1);
});

test("discovery normalization removes fragments and tracking parameters", () => {
  assert.equal(
    normalizeUrl("https://Example.com/path/?utm_source=test&b=2#section"),
    "https://example.com/path?b=2"
  );
  assert.equal(normalizeText("  repeated \n whitespace  "), "repeated whitespace");
  assert.equal(categorize("New LangGraph release"), "langchain-langgraph");
  const result = normalizeExaResult({
    title: "Testing a new attention mechanism",
    url: "https://medium.com/example?utm_source=test",
    text: "The author changes attention and reports an ablation.",
    highlights: ["A technical experiment with benchmark results."],
    publishedDate: "2026-07-01"
  }, 0);
  assert.equal(result.sourceName, "medium.com");
  assert.equal(result.sourceUrl, "https://medium.com/example");
});

test("learning feed deduplicates and enforces quality and domain diversity", () => {
  const candidate = (id, domain = "example.com") => ({
    candidateId: id,
    sourceUrl: `https://${domain}/${id}`,
    sourceTitle: `Technical experiment ${id}`,
    sourceName: domain,
    sourceContent: "Method, implementation, ablation, and benchmark.",
    sourceSnippet: "A technical experiment.",
    sourcePublishedAt: null,
    discoveredType: "experiment",
    category: "research"
  });
  const candidates = [
    candidate("one", "author.example"),
    candidate("two", "author.example"),
    candidate("three", "author.example"),
    candidate("four", "papers.example"),
    candidate("five", "tutorial.example"),
    candidate("six", "marketing.example")
  ];
  const assessment = (id, overrides = {}) => ({
    id,
    decision: "accept",
    contentType: "experiment",
    learningValue: 5,
    technicalDepth: 5,
    novelty: 4,
    evidence: 4,
    marketingPenalty: 0,
    reason: "Concrete technical investigation.",
    ...overrides
  });
  const assessments = [
    assessment("one"),
    assessment("two"),
    assessment("three"),
    assessment("four", { contentType: "research" }),
    assessment("five", { contentType: "tutorial" }),
    assessment("six", { decision: "reject", marketingPenalty: 5 })
  ];

  const selected = selectLearningUpdates(candidates, assessments, 5);
  assert.equal(selected.length, 4);
  assert.equal(
    selected.filter((item) => item.sourceName === "author.example").length,
    2
  );
  assert.equal(selected.some((item) => item.candidateId === "six"), false);

  const duplicates = deduplicateCandidates([
    candidate("a"),
    { ...candidate("b"), sourceUrl: "https://example.com/a" }
  ]);
  assert.equal(duplicates.length, 1);
});

test("hybrid discovery combines Exa articles and Semantic Scholar papers", async () => {
  const exaResult = (title, url) => ({
    title,
    url,
    text: "A concrete method with implementation details and benchmark results.",
    highlights: ["The author changes a model component and runs an ablation."],
    publishedDate: "2026-07-01"
  });
  let exaCall = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    let payload;
    if (value.includes("api.exa.ai")) {
      exaCall += 1;
      payload = {
        results: [exaResult(
          `Experiment ${exaCall}`,
          `https://author${exaCall}.example/experiment`
        )]
      };
    } else {
      payload = {
        data: [{
          title: "A modified Transformer attention mechanism",
          abstract: "We modify attention and report ablations on two benchmarks.",
          url: "https://www.semanticscholar.org/paper/example",
          publicationDate: "2026-06-15",
          citationCount: 3,
          openAccessPdf: { url: "https://arxiv.org/pdf/2606.00001" },
          externalIds: { ArXiv: "2606.00001" }
        }]
      };
    }
    return {
      ok: true,
      async json() { return payload; }
    };
  };

  const candidates = await discoverCandidates({
    exaApiKey: "test-key",
    fetchImpl,
    now: new Date("2026-07-27T00:00:00Z")
  });

  assert.equal(candidates.length, 4);
  assert.equal(candidates.filter((item) => item.discoveredType === "experiment").length, 2);
  assert.equal(candidates.filter((item) => item.discoveredType === "research").length, 2);
});

test("Semantic Scholar bulk search retries bounded rate-limit responses", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /\/paper\/search\/bulk/);
    if (calls < 3) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        async text() { return "Too Many Requests"; }
      };
    }
    return {
      ok: true,
      async json() { return { data: [] }; }
    };
  };

  const result = await fetchJsonWithRateLimitRetry(
    "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
    { method: "GET" },
    fetchImpl,
    {
      retryDelaysMs: [2_000, 5_000],
      sleepImpl: async (delay) => delays.push(delay)
    }
  );

  assert.deepEqual(result, { data: [] });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2_000, 5_000]);
});

test("Semantic Scholar discovery falls back to a fresh PostgreSQL cache", async () => {
  const cachedPayload = {
    data: [{
      title: "Cached transformer experiment",
      abstract: "We modify transformer routing and report benchmark results.",
      url: "https://www.semanticscholar.org/paper/cached",
      publicationDate: "2026-07-01",
      citationCount: 4,
      openAccessPdf: null,
      externalIds: {}
    }]
  };
  const pool = {
    async query(text) {
      assert.match(text, /FROM discovery_cache/);
      return {
        rowCount: 1,
        rows: [{
          payload: cachedPayload,
          fetched_at: new Date("2026-07-26T00:00:00Z")
        }]
      };
    }
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("api.exa.ai")) {
      return {
        ok: true,
        async json() { return { results: [] }; }
      };
    }
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      async text() { return "Too Many Requests"; }
    };
  };

  const candidates = await discoverCandidates({
    exaApiKey: "test-key",
    fetchImpl,
    pool,
    retryDelaysMs: [],
    now: new Date("2026-07-27T00:00:00Z")
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceTitle, "Cached transformer experiment");
  assert.equal(candidates[0].discoveredType, "research");
});

test("discovery cache stores JSON and rejects stale entries", async () => {
  const writes = [];
  const writePool = {
    async query(text, values) {
      writes.push({ text, values });
      return { rowCount: 1, rows: [] };
    }
  };
  await saveDiscoveryCache(writePool, "papers", { data: [{ title: "One" }] });
  assert.match(writes[0].text, /ON CONFLICT/);
  assert.equal(writes[0].values[0], "papers");
  assert.deepEqual(JSON.parse(writes[0].values[1]), {
    data: [{ title: "One" }]
  });

  const stalePool = {
    async query() {
      return {
        rowCount: 1,
        rows: [{
          payload: { data: [{ title: "Old" }] },
          fetched_at: new Date("2026-07-01T00:00:00Z")
        }]
      };
    }
  };
  const cached = await loadDiscoveryCache(stalePool, "papers", {
    now: new Date("2026-07-27T00:00:00Z"),
    maxAgeMs: 7 * 24 * 60 * 60 * 1000
  });
  assert.equal(cached, null);
});

test("candidate ranking is split into bounded AI batches", async () => {
  const calls = [];
  const ai = {
    async rankCandidates(candidates) {
      calls.push(candidates.length);
      return {
        assessments: candidates.map((candidate) => ({
          id: candidate.id,
          decision: "accept",
          contentType: candidate.sourceType,
          learningValue: 5,
          technicalDepth: 5,
          novelty: 4,
          evidence: 4,
          marketingPenalty: 0,
          reason: "Technical learning content."
        }))
      };
    }
  };
  const candidates = Array.from({ length: 23 }, (_, index) => ({
    candidateId: `candidate-${index + 1}`,
    sourceTitle: `Experiment ${index + 1}`,
    sourceName: `author${index % 4}.example`,
    sourceUrl: `https://author.example/${index + 1}`,
    sourceContent: "Method and benchmark.",
    sourceSnippet: "Method and benchmark.",
    sourcePublishedAt: null,
    discoveredType: "experiment",
    category: "research"
  }));

  const assessments = await rankCandidateBatches(ai, candidates, 10);
  assert.deepEqual(calls, [10, 10, 3]);
  assert.equal(assessments.length, 23);
});

test("existing article URLs are removed before AI ranking", async () => {
  const candidates = [
    { candidateId: "new", sourceUrl: "https://example.com/new" },
    { candidateId: "old", sourceUrl: "https://example.com/old" }
  ];
  const pool = {
    async query(text, values) {
      assert.match(text, /source_url = ANY/);
      assert.deepEqual(values[0], candidates.map((item) => item.sourceUrl));
      return { rows: [{ source_url: "https://example.com/old" }] };
    }
  };

  const filtered = await filterExistingCandidates(pool, candidates);
  assert.deepEqual(filtered, [candidates[0]]);
});

test("database conflict behavior counts only inserted discovery rows", async () => {
  const urls = new Set();
  const pool = {
    async query(_text, values) {
      if (urls.has(values[0])) return { rowCount: 0 };
      urls.add(values[0]);
      return { rowCount: 1 };
    }
  };
  const update = {
    sourceUrl: "https://example.com/one",
    sourceTitle: "One",
    sourceName: "example.com",
    sourceContent: "Content",
    sourceSnippet: "Snippet",
    sourcePublishedAt: null,
    category: "other"
  };
  assert.equal(await saveDiscoveredUpdates(pool, [update, update]), 1);
});
