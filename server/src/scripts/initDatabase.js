import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../db.js";

const sqlPath = fileURLToPath(new URL("../../sql/init.sql", import.meta.url));
const pool = createPool();
try {
  await pool.query(await readFile(sqlPath, "utf8"));
  console.log("Database schema is up to date.");
} catch (error) {
  console.error(`Database initialization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
