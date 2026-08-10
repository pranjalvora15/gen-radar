export const DISCOVERY_LIMIT = 10;
export const SEMANTIC_SCHOLAR_CACHE_KEY = "semantic-scholar:genai-bulk:v1";
export const SEMANTIC_SCHOLAR_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SEMANTIC_SCHOLAR_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
export const SEMANTIC_SCHOLAR_RESULT_LIMIT = 20;
export const DISCOVERY_CONTENT_MAX_CHARACTERS = 6_000;

export const PRACTITIONER_DOMAINS = [
  "medium.com",
  "towardsdatascience.com",
  "huggingface.co",
  "lilianweng.github.io",
  "sebastianraschka.com",
  "magazine.sebastianraschka.com",
  "research.google",
  "microsoft.com",
  "developer.nvidia.com",
  "anthropic.com"
];

export const LEARNING_QUERY = `
Recent deeply technical Generative AI articles where an author introduces,
implements, reproduces, compares, or tests an architecture, training method,
retrieval strategy, agent technique, evaluation method, inference optimization,
or multimodal approach. Prefer experiments, ablations, benchmarks, code, and
implementation details. Exclude product announcements, customer stories,
business news, generic trend posts, and marketing.
`.replace(/\s+/g, " ").trim();

const trackingKeys = new Set([
  "fbclid", "gclid", "ref", "source", "utm_campaign", "utm_content",
  "utm_medium", "utm_source", "utm_term"
]);

export function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingKeys.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

export function normalizeText(value = "", limit = 30_000) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;

  const candidate = text.slice(0, limit + 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf("! ")
  );
  if (sentenceEnd >= Math.floor(limit * 0.6)) {
    return candidate.slice(0, sentenceEnd + 1);
  }

  const wordEnd = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, wordEnd > 0 ? wordEnd : limit).trim()}…`;
}

export function categorize(text) {
  const value = ` ${text.toLowerCase()} `;
  const rules = [
    ["langchain-langgraph", ["langchain", "langgraph"]],
    ["rag", ["retrieval augmented", "rerank", " rag "]],
    ["agents", ["agentic", "agent", "tool use"]],
    ["multimodal", ["vision-language", "multimodal", "image", "audio", "video"]],
    ["safety", ["alignment", "red team", "model safety", "safety"]],
    ["research", ["paper", "benchmark", "study", "evaluation", "ablation"]],
    ["models", ["transformer", "architecture", "fine-tun", "inference", "llm", "model"]]
  ];
  return rules.find(([, signals]) => signals.some((signal) => value.includes(signal)))?.[0] || "other";
}

function sourceName(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(
      `Discovery request failed (${response.status}): ${detail.slice(0, 300)}`
    );
    error.status = response.status;
    const retryAfter = response.headers?.get?.("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const delay = Number.isFinite(seconds)
        ? seconds * 1_000
        : new Date(retryAfter).getTime() - Date.now();
      if (Number.isFinite(delay) && delay > 0) {
        error.retryAfterMs = delay;
      }
    }
    throw error;
  }
  return response.json();
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function fetchJsonWithRateLimitRetry(
  url,
  options,
  fetchImpl,
  {
    retryDelaysMs = SEMANTIC_SCHOLAR_RETRY_DELAYS_MS,
    sleepImpl = sleep
  } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchJson(url, options, fetchImpl);
    } catch (error) {
      const fallbackDelay = retryDelaysMs[attempt];
      if (error.status !== 429 || fallbackDelay === undefined) throw error;
      const delay = Math.min(
        Math.max(error.retryAfterMs || fallbackDelay, fallbackDelay),
        30_000
      );
      await sleepImpl(delay);
    }
  }
}

export async function ensureDiscoveryCacheTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS discovery_cache (
       cache_key TEXT PRIMARY KEY,
       payload JSONB NOT NULL,
       fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
}

export async function loadDiscoveryCache(
  pool,
  cacheKey,
  {
    now = new Date(),
    maxAgeMs = SEMANTIC_SCHOLAR_CACHE_MAX_AGE_MS
  } = {}
) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT payload, fetched_at
       FROM discovery_cache
      WHERE cache_key = $1`,
    [cacheKey]
  );
  if (result.rowCount === 0) return null;

  const fetchedAt = new Date(result.rows[0].fetched_at);
  if (
    Number.isNaN(fetchedAt.getTime())
    || now.getTime() - fetchedAt.getTime() > maxAgeMs
  ) {
    return null;
  }
  return result.rows[0].payload;
}

export async function saveDiscoveryCache(pool, cacheKey, payload) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO discovery_cache (cache_key, payload, fetched_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (cache_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           fetched_at = EXCLUDED.fetched_at`,
    [cacheKey, JSON.stringify(payload)]
  );
}

function exaPayload({ category, includeDomains, startPublishedDate }) {
  return {
    query: LEARNING_QUERY,
    type: "auto",
    numResults: 10,
    ...(category ? { category } : {}),
    ...(includeDomains ? { includeDomains } : {}),
    startPublishedDate,
    contents: {
      text: { maxCharacters: DISCOVERY_CONTENT_MAX_CHARACTERS },
      highlights: {
        query: "technical method architecture experiment implementation ablation benchmark results",
        maxCharacters: 1_500
      }
    }
  };
}

export function normalizeExaResult(result, index, discoveredType = "experiment") {
  const url = normalizeUrl(result.url);
  const highlights = Array.isArray(result.highlights)
    ? result.highlights.join(" ")
    : "";
  const content = normalizeText(result.text || highlights);
  const snippet = normalizeText(highlights || content, 500);
  const title = normalizeText(result.title, 500);
  if (!title || !content) return null;

  return {
    candidateId: `exa-${index}`,
    sourceUrl: url,
    sourceTitle: title,
    sourceName: sourceName(url),
    sourceContent: content,
    sourceSnippet: snippet,
    sourcePublishedAt: result.publishedDate || null,
    discoveredType,
    category: categorize(`${title} ${snippet}`)
  };
}

export function normalizeSemanticScholarPaper(paper, index) {
  const abstract = normalizeText(paper.abstract || "");
  const title = normalizeText(paper.title || "", 500);
  if (!title || !abstract) return null;

  const arxivId = paper.externalIds?.ArXiv;
  const sourceUrl = normalizeUrl(
    arxivId
      ? `https://arxiv.org/abs/${arxivId}`
      : paper.openAccessPdf?.url || paper.url
  );

  return {
    candidateId: `paper-${index}`,
    sourceUrl,
    sourceTitle: title,
    sourceName: sourceName(sourceUrl),
    sourceContent: abstract,
    sourceSnippet: normalizeText(abstract, 500),
    sourcePublishedAt: paper.publicationDate || null,
    discoveredType: "research",
    citationCount: Number(paper.citationCount || 0),
    hasOpenAccessPdf: Boolean(paper.openAccessPdf?.url),
    category: categorize(`${title} ${abstract} paper study`)
  };
}

export function deduplicateCandidates(candidates) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  return candidates.filter((candidate) => {
    if (!candidate) return false;
    const titleKey = candidate.sourceTitle.toLowerCase().replace(/\W+/g, " ").trim();
    if (seenUrls.has(candidate.sourceUrl) || seenTitles.has(titleKey)) return false;
    seenUrls.add(candidate.sourceUrl);
    seenTitles.add(titleKey);
    return true;
  }).map((candidate, index) => ({
    ...candidate,
    candidateId: `candidate-${index + 1}`
  }));
}

export async function discoverCandidates({
  exaApiKey = process.env.EXA_API_KEY,
  semanticScholarApiKey = process.env.SEMANTIC_SCHOLAR_API_KEY,
  fetchImpl = fetch,
  now = new Date(),
  pool,
  retryDelaysMs = SEMANTIC_SCHOLAR_RETRY_DELAYS_MS,
  sleepImpl = sleep
} = {}) {
  if (!exaApiKey) {
    throw new Error("EXA_API_KEY is required");
  }

  const startPublishedDate = new Date(
    now.getTime() - (120 * 24 * 60 * 60 * 1000)
  ).toISOString();
  const currentYear = now.getUTCFullYear();
  const paperUrl = new URL(
    "https://api.semanticscholar.org/graph/v1/paper/search/bulk"
  );
  paperUrl.searchParams.set(
    "query",
    '("generative ai" | "large language model" | transformer | '
    + '"retrieval augmented generation" | agent | multimodal)'
  );
  paperUrl.searchParams.set("year", `${currentYear - 1}-${currentYear}`);
  paperUrl.searchParams.set("sort", "publicationDate:desc");
  paperUrl.searchParams.set(
    "fields",
    "title,abstract,url,publicationDate,openAccessPdf,citationCount,externalIds"
  );

  const exaHeaders = {
    "Content-Type": "application/json",
    "x-api-key": exaApiKey
  };
  const scholarHeaders = semanticScholarApiKey
    ? { "x-api-key": semanticScholarApiKey }
    : {};

  const requests = await Promise.allSettled([
    fetchJson("https://api.exa.ai/search", {
      method: "POST",
      headers: exaHeaders,
      body: JSON.stringify(exaPayload({
        includeDomains: PRACTITIONER_DOMAINS,
        startPublishedDate
      }))
    }, fetchImpl),
    fetchJson("https://api.exa.ai/search", {
      method: "POST",
      headers: exaHeaders,
      body: JSON.stringify(exaPayload({
        category: "personal site",
        startPublishedDate
      }))
    }, fetchImpl),
    fetchJson("https://api.exa.ai/search", {
      method: "POST",
      headers: exaHeaders,
      body: JSON.stringify(exaPayload({
        category: "research paper",
        startPublishedDate
      }))
    }, fetchImpl),
    fetchJsonWithRateLimitRetry(
      paperUrl,
      {
        method: "GET",
        headers: scholarHeaders
      },
      fetchImpl,
      { retryDelaysMs, sleepImpl }
    )
  ]);

  const [practitionerResult, personalResult, exaPaperResult, scholarResult] = requests;
  const exaRequestResults = [practitionerResult, personalResult, exaPaperResult];
  if (exaRequestResults.every((result) => result.status === "rejected")) {
    throw new Error(
      `Exa discovery failed: ${exaRequestResults[0].reason?.message || "unknown error"}`
    );
  }
  for (const result of exaRequestResults) {
    if (result.status === "rejected") {
      console.warn(`Optional discovery source skipped: ${result.reason.message}`);
    }
  }

  const practitionerResponse = practitionerResult.status === "fulfilled"
    ? practitionerResult.value
    : { results: [] };
  const personalResponse = personalResult.status === "fulfilled"
    ? personalResult.value
    : { results: [] };
  const exaPaperResponse = exaPaperResult.status === "fulfilled"
    ? exaPaperResult.value
    : { results: [] };
  let paperResponse = { data: [] };
  if (scholarResult.status === "fulfilled") {
    paperResponse = {
      ...scholarResult.value,
      data: (scholarResult.value.data || []).slice(
        0,
        SEMANTIC_SCHOLAR_RESULT_LIMIT
      )
    };
    try {
      await saveDiscoveryCache(
        pool,
        SEMANTIC_SCHOLAR_CACHE_KEY,
        paperResponse
      );
    } catch (error) {
      console.warn(`Semantic Scholar cache write skipped: ${error.message}`);
    }
  } else {
    try {
      const cached = await loadDiscoveryCache(
        pool,
        SEMANTIC_SCHOLAR_CACHE_KEY,
        { now }
      );
      if (cached) {
        paperResponse = cached;
        console.warn(
          "Semantic Scholar unavailable; using cached research papers."
        );
      } else {
        console.warn(
          `Optional discovery source skipped: ${scholarResult.reason.message}`
        );
      }
    } catch (error) {
      console.warn(
        `Optional discovery source skipped: ${scholarResult.reason.message}; `
        + `cache unavailable: ${error.message}`
      );
    }
  }
  const exaResults = [
    ...(practitionerResponse.results || []),
    ...(personalResponse.results || [])
  ];
  const candidates = [
    ...exaResults.map(
      (result, index) => normalizeExaResult(result, index, "experiment")
    ),
    ...(exaPaperResponse.results || []).map(
      (result, index) => normalizeExaResult(
        result,
        exaResults.length + index,
        "research"
      )
    ),
    ...(paperResponse.data || []).map(normalizeSemanticScholarPaper)
  ];
  return deduplicateCandidates(candidates);
}

export function rankingPayload(candidates) {
  return candidates.map((candidate) => ({
    id: candidate.candidateId,
    title: candidate.sourceTitle,
    sourceName: candidate.sourceName,
    sourceType: candidate.discoveredType,
    excerpt: normalizeText(candidate.sourceSnippet || candidate.sourceContent, 1_500),
    publishedAt: candidate.sourcePublishedAt,
    citationCount: candidate.citationCount || 0,
    hasOpenAccessPdf: Boolean(candidate.hasOpenAccessPdf)
  }));
}

export async function rankCandidateBatches(
  ai,
  candidates,
  batchSize = 10
) {
  const payload = rankingPayload(candidates);
  const assessments = [];
  for (let index = 0; index < payload.length; index += batchSize) {
    const result = await ai.rankCandidates(payload.slice(index, index + batchSize));
    assessments.push(...result.assessments);
  }
  return assessments;
}

export async function filterExistingCandidates(pool, candidates) {
  if (!candidates.length) return [];
  const result = await pool.query(
    `SELECT source_url
       FROM updates
      WHERE source_url = ANY($1::text[])`,
    [candidates.map((candidate) => candidate.sourceUrl)]
  );
  const existingUrls = new Set(result.rows.map((row) => row.source_url));
  return candidates.filter((candidate) => !existingUrls.has(candidate.sourceUrl));
}

function assessmentScore(assessment) {
  return (
    assessment.learningValue
    + assessment.technicalDepth
    + assessment.novelty
    + assessment.evidence
    - (assessment.marketingPenalty * 2)
  );
}

export function selectLearningUpdates(
  candidates,
  assessments,
  limit = DISCOVERY_LIMIT
) {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const ranked = assessments.flatMap((assessment) => {
    const candidate = byId.get(assessment.id);
    if (
      !candidate
      || assessment.decision !== "accept"
      || assessment.learningValue < 4
      || assessment.technicalDepth < 3
      || assessment.marketingPenalty > 2
    ) {
      return [];
    }
    return [{
      candidate,
      assessment,
      score: assessmentScore(assessment)
    }];
  }).sort((left, right) => right.score - left.score);

  const selected = [];
  const selectedUrls = new Set();
  const domainCounts = new Map();
  const typeTargets = [
    ["research", 4],
    ["experiment", 3],
    ["tutorial", 3]
  ];

  function add(item) {
    const domain = item.candidate.sourceName;
    if (
      selectedUrls.has(item.candidate.sourceUrl)
      || (domainCounts.get(domain) || 0) >= 2
    ) return false;
    selected.push(item);
    selectedUrls.add(item.candidate.sourceUrl);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    return true;
  }

  for (const [type, target] of typeTargets) {
    let added = 0;
    for (const item of ranked) {
      if (selected.length >= limit || added >= target) break;
      if (item.assessment.contentType === type && add(item)) added += 1;
    }
  }
  for (const item of ranked) {
    if (selected.length >= limit) break;
    add(item);
  }

  return selected.map(({ candidate }) => candidate);
}

export async function saveDiscoveredUpdates(pool, updates) {
  let inserted = 0;
  for (const update of updates) {
    const result = await pool.query(
      `INSERT INTO updates (
         source_url, source_title, source_name, source_content,
         source_snippet, display_summary, content_hash, content_length,
         content_truncated, extracted_at, extraction_method,
         source_published_at, category
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (source_url) DO NOTHING`,
      [
        update.sourceUrl,
        update.sourceTitle,
        update.sourceName,
        update.sourceContent,
        update.sourceSnippet,
        update.displaySummary || update.sourceSnippet,
        update.contentHash || null,
        update.contentLength ?? update.sourceContent.length,
        Boolean(update.contentTruncated),
        update.extractedAt || null,
        update.extractionMethod || "discovery",
        update.sourcePublishedAt,
        update.category
      ]
    );
    inserted += result.rowCount;
  }
  return inserted;
}
