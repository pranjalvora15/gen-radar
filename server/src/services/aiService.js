function createHttpError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const RETRYABLE_GATEWAY_STATUS_CODES = new Set([502, 503, 504]);
// A sleeping Render Free service can take about a minute to become ready.
// These delays provide a bounded 72-second wake-up window without extending
// the timeout for a request that has already reached the AI application.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 20_000, 20_000];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableGatewayResponse(response, responseBody) {
  if (!RETRYABLE_GATEWAY_STATUS_CODES.has(response.status)) {
    return false;
  }

  // FastAPI returns structured JSON when the AI application handled the
  // request. Let that application error reach the caller instead of repeating
  // an expensive model call. Render's cold-start gateway response has no such
  // structured detail.
  return !responseBody.detail && !responseBody.message;
}

export function createAiService(baseUrl = process.env.AI_SERVICE_URL || "http://localhost:8000") {
  const internalApiKey = process.env.AI_INTERNAL_API_KEY;

  function internalHeaders(headers = {}) {
    return {
      ...headers,
      ...(internalApiKey ? { "X-Internal-API-Key": internalApiKey } : {})
    };
  }

  async function post(path, body, timeout = 60_000) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: internalHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout)
        });
      } catch (error) {
        if (error?.name === "TimeoutError") {
          throw createHttpError("AI service request timed out", 503);
        }
        if (attempt < RETRY_DELAYS_MS.length) {
          await wait(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw createHttpError("AI service is unavailable", 503);
      }

      if (response.ok) {
        return response.json();
      }

      const responseBody = await response.json().catch(() => ({}));
      if (
        isRetryableGatewayResponse(response, responseBody)
        && attempt < RETRY_DELAYS_MS.length
      ) {
        await wait(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      const statusCode = response.status >= 400 && response.status < 500
        ? response.status
        : 503;
      throw createHttpError(
        responseBody.detail || responseBody.message || "AI service request failed",
        statusCode
      );
    }

    throw createHttpError("AI service is unavailable", 503);
  }

  async function postFile(path, filename, bytes, timeout = 180_000) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: internalHeaders(),
        body: form,
        signal: AbortSignal.timeout(timeout)
      });
    } catch {
      throw createHttpError("AI service is unavailable", 503);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const statusCode = response.status === 422 ? 422 : 503;
      throw createHttpError(body.detail || "AI service could not process the paper", statusCode);
    }
    return response.json();
  }

  return {
    explainArticle(update) {
      return post("/ai/explain-article", {
        title: update.sourceTitle,
        source_name: update.sourceName,
        url: update.sourceUrl,
        content: update.sourceContent
      });
    },
    explainKeyword(update, keyword) {
      return post("/ai/explain-keyword", {
        keyword,
        title: update.sourceTitle,
        content: update.sourceContent,
        article_explanation: update.explanation
      });
    },
    rankCandidates(candidates) {
      return post("/ai/rank-candidates", { candidates });
    },
    summarizeFeedArticles(articles) {
      return post("/ai/summarize-feed-articles", { articles }, 120_000);
    },
    embedDocuments(article) {
      return post("/ai/embed-documents", article);
    },
    embedQuery(query) {
      return post("/ai/embed-query", { query });
    },
    embedPaperQuery(query) {
      return post("/ai/embed-paper-query", { query });
    },
    routeQuestion(input) {
      return post("/ai/route-question", input);
    },
    answerQuestion(input) {
      return post("/ai/answer-question", input);
    },
    judgeAnswer(input) {
      return post("/ai/judge-answer", input);
    },
    summarizeConversation(input) {
      return post("/ai/summarize-conversation", input);
    },
    checkQuestionScope(input) {
      return post("/ai/check-question-scope", input);
    },
    suggestQuestions(input) {
      return post("/ai/suggest-questions", input);
    },
    analyzeMedia(input) {
      return post("/ai/analyze-media", input, 120_000);
    },
    gradeEvidence(input) {
      return post("/ai/grade-evidence", input);
    },
    superviseAnswer(input) {
      return post("/ai/supervise-answer", input, 120_000);
    },
    inspectPaper(filename, bytes) {
      return postFile("/ai/inspect-paper", filename, bytes);
    },
    embedPaperPages(input) {
      return post("/ai/embed-paper-pages", input, 420_000);
    },
    explainPaperSelection(input) {
      return post("/ai/explain-paper-selection", input, 120_000);
    },
    explainPaperFigure(input) {
      return post("/ai/explain-paper-figure", input, 120_000);
    },
    answerPaperQuestion(input) {
      return post("/ai/answer-paper-question", input, 120_000);
    }
  };
}
