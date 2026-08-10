import "dotenv/config";
import { createPool } from "../db.js";
import { createAiService } from "../services/aiService.js";
import { createExaService } from "../services/exaService.js";
import { createFeedRefreshService } from "../services/feedRefreshService.js";

const pool = createPool();
const ai = createAiService();
const exa = createExaService();

try {
  const refresh = createFeedRefreshService({
    database: pool,
    ai,
    exa,
    logger: console
  });
  const result = await refresh.refreshNow({ force: true });
  const summary = result.summary;
  console.log(
    `Discovery complete: ${summary.found} candidate(s), `
    + `${summary.newCandidates} new candidate(s), `
    + `${summary.selected} selected, ${summary.inserted} inserted.`
  );
} catch (error) {
  console.error(`Discovery failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
