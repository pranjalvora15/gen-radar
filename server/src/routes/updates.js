import { mapUpdate } from "../db.js";
import { loadUpdate } from "../prehandlers.js";
import {
  explainArticleSchema,
  explainKeywordSchema,
  getUpdateSchema,
  listUpdatesSchema
} from "../schemas.js";

export function keywordKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hasCurrentArticleExplanation(value) {
  return Boolean(
    value
    && typeof value.problemSolved === "string"
    && Array.isArray(value.tradeOffs)
    && Array.isArray(value.limitations)
  );
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForGeneratedExplanation(database, updateId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await database.query(
      `SELECT explanation, explanation_status
         FROM updates
        WHERE id = $1`,
      [updateId]
    );
    const row = result.rows[0];
    if (hasCurrentArticleExplanation(row?.explanation)) {
      return row.explanation;
    }
    if (row?.explanation_status === "failed") break;
    await wait(500);
  }
  return null;
}

async function ensureCompleteSource(fastify, update) {
  if (update.extractionMethod === "exa-contents" && !update.contentTruncated) {
    return update;
  }

  try {
    const extracted = await fastify.exa.extractArticle(update.sourceUrl);
    await fastify.db.query(
      `UPDATE updates
          SET source_content = $2, content_hash = $3, content_length = $4,
              content_truncated = $5, extracted_at = NOW(),
              extraction_method = $6, updated_at = NOW()
        WHERE id = $1`,
      [
        update.id,
        extracted.content,
        extracted.contentHash,
        extracted.content.length,
        Boolean(extracted.contentTruncated),
        extracted.extractionMethod || "exa-contents"
      ]
    );
    return {
      ...update,
      sourceContent: extracted.content,
      contentHash: extracted.contentHash,
      contentLength: extracted.content.length,
      contentTruncated: Boolean(extracted.contentTruncated),
      extractedAt: new Date().toISOString(),
      extractionMethod: extracted.extractionMethod || "exa-contents"
    };
  } catch (error) {
    fastify.log.warn({ error, updateId: update.id }, "Article re-extraction failed; using cached source content");
    return update;
  }
}

export default async function updateRoutes(fastify) {
  fastify.get("/api/updates", { schema: listUpdatesSchema }, async () => {
    const feed = await fastify.feedRefresh.state();
    const result = await fastify.db.query(
      `SELECT id, source_url, source_title, source_name, source_snippet,
              display_summary, source_published_at, discovered_at, category,
              explanation, explanation_status, keywords
         FROM updates
        ORDER BY discovered_at DESC
        LIMIT 100`
    );
    return {
      updates: result.rows
        .map(mapUpdate)
        .slice(0, 10),
      feed: {
        refreshing: Boolean(feed.refreshing),
        lastRefreshedAt: feed.lastRefreshedAt || null,
        lastError: feed.lastError || null
      }
    };
  });

  fastify.get("/api/updates/:id", {
    schema: getUpdateSchema,
    preHandler: loadUpdate
  }, async (request) => ({ update: request.update }));

  fastify.post("/api/updates/:id/explain", {
    schema: explainArticleSchema,
    preHandler: loadUpdate
  }, async (request, reply) => {
    if (hasCurrentArticleExplanation(request.update.explanation)) {
      return { explanation: request.update.explanation, cached: true };
    }

    const claimed = await fastify.db.query(
      `UPDATE updates
          SET explanation_status = 'generating',
              explanation_started_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND (
            explanation_status <> 'generating'
            OR explanation_started_at < NOW() - INTERVAL '2 minutes'
          )
      RETURNING id`,
      [request.update.id]
    );

    if (claimed.rowCount === 0) {
      const explanation = await waitForGeneratedExplanation(
        fastify.db,
        request.update.id
      );
      if (explanation) return { explanation, cached: true };
      return reply.code(503).send({
        message: "The article explanation is still being generated. Try again shortly."
      });
    }

    try {
      const completeUpdate = await ensureCompleteSource(fastify, request.update);
      const generated = await fastify.ai.explainArticle(completeUpdate);
      const result = await fastify.db.query(
        `UPDATE updates
            SET explanation = $2::jsonb,
                explanation_status = 'ready', explanation_started_at = NULL,
                category = $3, keywords = $4::jsonb, updated_at = NOW()
          WHERE id = $1
          RETURNING explanation`,
        [
          request.update.id,
          JSON.stringify(generated),
          generated.category,
          JSON.stringify(generated.keywords)
        ]
      );
      return { explanation: result.rows[0].explanation, cached: false };
    } catch (error) {
      await fastify.db.query(
        `UPDATE updates
            SET explanation_status = 'failed', explanation_started_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [request.update.id]
      );
      throw error;
    }
  });

  fastify.post("/api/updates/:id/keywords/explain", {
    schema: explainKeywordSchema,
    preHandler: loadUpdate
  }, async (request, reply) => {
    const requestedKey = keywordKey(request.body.keyword);
    const storedKeyword = request.update.keywords.find(
      (keyword) => keywordKey(keyword) === requestedKey
    );

    if (!storedKeyword || !request.update.explanation) {
      return reply.code(400).send({
        message: "Choose a keyword generated for this update"
      });
    }

    const cached = await fastify.db.query(
      `SELECT explanation
         FROM keyword_explanations
        WHERE update_id = $1 AND keyword_key = $2`,
      [request.update.id, requestedKey]
    );

    if (cached.rowCount > 0) {
      return { explanation: cached.rows[0].explanation, cached: true };
    }

    const generated = await fastify.ai.explainKeyword(
      request.update,
      storedKeyword
    );

    await fastify.db.query(
      `INSERT INTO keyword_explanations
        (update_id, keyword, keyword_key, explanation)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (update_id, keyword_key) DO NOTHING`,
      [
        request.update.id,
        storedKeyword,
        requestedKey,
        JSON.stringify(generated)
      ]
    );

    const saved = await fastify.db.query(
      `SELECT explanation
         FROM keyword_explanations
        WHERE update_id = $1 AND keyword_key = $2`,
      [request.update.id, requestedKey]
    );

    return { explanation: saved.rows[0].explanation, cached: false };
  });
}
