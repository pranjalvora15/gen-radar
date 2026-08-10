import { openDB } from "idb";

const DATABASE_NAME = "genradar-private-papers";
const STORE_NAME = "paper-workspaces";

const database = openDB(DATABASE_NAME, 1, {
  upgrade(db) {
    db.createObjectStore(STORE_NAME, { keyPath: "workspaceId" });
  }
});

export async function savePaperBlob(record) {
  return (await database).put(STORE_NAME, record);
}

export async function getPaperBlob(workspaceId) {
  return (await database).get(STORE_NAME, workspaceId);
}

export async function deletePaperBlob(workspaceId) {
  return (await database).delete(STORE_NAME, workspaceId);
}

export async function clearPaperBlobs() {
  return (await database).clear(STORE_NAME);
}

export async function updatePaperExpiry(workspaceId, expiresAt) {
  const db = await database;
  const record = await db.get(STORE_NAME, workspaceId);
  if (!record) return;
  await db.put(STORE_NAME, { ...record, expiresAt });
}

export async function cleanupExpiredPaperBlobs(now = Date.now()) {
  const db = await database;
  const records = await db.getAll(STORE_NAME);
  await Promise.all(
    records
      .filter((record) => new Date(record.expiresAt).getTime() <= now)
      .map((record) => db.delete(STORE_NAME, record.workspaceId))
  );
}

export async function hashPdf(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
