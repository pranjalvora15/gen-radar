import {
  discoverCandidates,
  filterExistingCandidates,
  rankCandidateBatches,
  saveDiscoveredUpdates,
  selectLearningUpdates
} from "./learningFeedService.js";

const DEFAULT_REFRESH_HOURS = 48;
const STUCK_REFRESH_MINUTES = 30;
const SUMMARY_CONTEXT_CHARACTERS = 6_000;

function summaryContext(content) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= SUMMARY_CONTEXT_CHARACTERS) return normalized;
  return `${normalized.slice(0, 4_000)}\n\n[Later in the article]\n\n${normalized.slice(-2_000)}`;
}

async function hydrateSelectedArticles(exa, selected, logger) {
  const hydrated = [];
  for (const candidate of selected) {
    try {
      const extracted = await exa.extractArticle(candidate.sourceUrl);
      hydrated.push({
        ...candidate,
        sourceTitle: extracted.title || candidate.sourceTitle,
        sourceName: extracted.sourceName || candidate.sourceName,
        sourceContent: extracted.content,
        contentHash: extracted.contentHash,
        contentLength: extracted.content.length,
        contentTruncated: Boolean(extracted.contentTruncated),
        extractedAt: new Date().toISOString(),
        extractionMethod: extracted.extractionMethod || "exa-contents"
      });
    } catch (error) {
      logger?.warn?.(
        { error, url: candidate.sourceUrl },
        "Selected feed article full extraction failed; using discovery content"
      );
      hydrated.push({
        ...candidate,
        contentLength: candidate.sourceContent.length,
        contentTruncated: true,
        extractedAt: new Date().toISOString(),
        extractionMethod: "discovery-fallback"
      });
    }
  }
  return hydrated;
}

async function addDisplaySummaries(ai, articles) {
  if (!articles.length) return [];
  const response = await ai.summarizeFeedArticles(
    articles.map((article) => ({
      id: article.candidateId,
      title: article.sourceTitle,
      sourceName: article.sourceName,
      content: summaryContext(article.sourceContent)
    }))
  );
  const summaries = new Map(
    response.summaries.map((item) => [item.id, item.summary.trim()])
  );
  return articles.map((article) => ({
    ...article,
    displaySummary: summaries.get(article.candidateId) || article.sourceSnippet
  }));
}

export async function refreshFeed({ database, ai, exa, logger }) {
  const candidates = await discoverCandidates({ pool: database });
  const newCandidates = await filterExistingCandidates(database, candidates);
  if (!newCandidates.length) {
    return { found: candidates.length, newCandidates: 0, selected: 0, inserted: 0 };
  }

  const assessments = await rankCandidateBatches(ai, newCandidates);
  const selected = selectLearningUpdates(newCandidates, assessments);
  const hydrated = await hydrateSelectedArticles(exa, selected, logger);
  const summarized = await addDisplaySummaries(ai, hydrated);
  const inserted = await saveDiscoveredUpdates(database, summarized);
  return {
    found: candidates.length,
    newCandidates: newCandidates.length,
    selected: selected.length,
    inserted
  };
}

export function createFeedRefreshService({ database, ai, exa, logger }) {
  const refreshHours = Number(
    process.env.FEED_REFRESH_INTERVAL_HOURS || DEFAULT_REFRESH_HOURS
  );

  async function state() {
    const result = await database.query(
      `SELECT status, last_started_at, last_completed_at, last_error
         FROM feed_refresh_state
        WHERE id = 1`
    );
    const row = result.rows[0] || {};
    return {
      status: row.status || "idle",
      refreshing: row.status === "refreshing",
      lastStartedAt: row.last_started_at || null,
      lastRefreshedAt: row.last_completed_at || null,
      lastError: row.last_error || null
    };
  }

  async function claim(force = false) {
    const staleBefore = new Date(Date.now() - refreshHours * 60 * 60 * 1_000);
    const stuckBefore = new Date(Date.now() - STUCK_REFRESH_MINUTES * 60 * 1_000);
    const result = await database.query(
      `UPDATE feed_refresh_state
          SET status = 'refreshing', last_started_at = NOW(),
              last_error = NULL, updated_at = NOW()
        WHERE id = 1
          AND (status <> 'refreshing' OR last_started_at < $2)
          AND ($3::boolean OR last_completed_at IS NULL OR last_completed_at < $1)
      RETURNING last_started_at`,
      [staleBefore, stuckBefore, force]
    );
    return result.rowCount > 0;
  }

  async function runClaimed() {
    try {
      const summary = await refreshFeed({ database, ai, exa, logger });
      await database.query(
        `UPDATE feed_refresh_state
            SET status = 'idle', last_completed_at = NOW(), last_error = NULL,
                updated_at = NOW()
          WHERE id = 1`,
      );
      logger?.info?.(summary, "Feed refresh completed");
      return summary;
    } catch (error) {
      await database.query(
        `UPDATE feed_refresh_state
            SET status = 'failed', last_error = $1, updated_at = NOW()
          WHERE id = 1`,
        [error.message.slice(0, 1_000)]
      );
      logger?.error?.({ error }, "Feed refresh failed");
      throw error;
    }
  }

  return {
    state,
    async checkAndTrigger() {
      if (await claim(false)) {
        void runClaimed().catch(() => {});
        return { ...(await state()), refreshing: true };
      }
      return state();
    },
    async refreshNow({ force = true } = {}) {
      if (!(await claim(force))) {
        return { claimed: false, state: await state() };
      }
      return { claimed: true, summary: await runClaimed(), state: await state() };
    }
  };
}
