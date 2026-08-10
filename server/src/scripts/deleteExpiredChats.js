import "dotenv/config";
import { createPool } from "../db.js";
import { deleteExpiredChats } from "../services/chatCleanupService.js";
import { deleteExpiredPaperData } from "../services/paperWorkspaceService.js";

const pool = createPool();
try {
  const deleted = await deleteExpiredChats(pool);
  const deletedPaperWorkspaces = await deleteExpiredPaperData(pool);
  console.log(
    `Expiry cleanup complete: ${deleted} conversation(s) and `
    + `${deletedPaperWorkspaces} paper workspace(s) deleted.`
  );
} catch (error) {
  console.error(`Expired chat cleanup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
