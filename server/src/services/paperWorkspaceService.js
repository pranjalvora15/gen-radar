import { createHash, createHmac, randomBytes } from "node:crypto";

export const PAPER_COOKIE = "genradar_pdf_workspace";
export const PAPER_EXPIRY_HOURS = Number(process.env.PAPER_WORKSPACE_EXPIRY_HOURS || 24);
export const PAPER_ACTION_LIMIT = Number(process.env.PAPER_WORKSPACE_ACTION_LIMIT || 20);

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createOwnerToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashIp(ip) {
  const secret = process.env.PAPER_WORKSPACE_SECRET || "genradar-local-paper-secret";
  return createHmac("sha256", secret).update(ip || "unknown").digest("hex");
}

export function paperCookieOptions(expiresAt) {
  const production = process.env.NODE_ENV === "production";
  return {
    path: "/",
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    expires: new Date(expiresAt)
  };
}

export function mapPaperWorkspace(row) {
  return {
    id: row.workspace_id ?? row.id,
    status: row.workspace_status ?? row.status,
    originalFilename: row.original_filename,
    currentPage: Number(row.current_page || 1),
    zoom: Number(row.zoom || 1),
    aiActionCount: Number(row.ai_action_count || 0),
    aiActionLimit: PAPER_ACTION_LIMIT,
    expiresAt: row.expires_at,
    createdAt: row.workspace_created_at ?? row.created_at,
    document: {
      id: Number(row.document_id),
      hash: row.file_hash,
      title: row.title,
      pageCount: row.page_count ? Number(row.page_count) : null,
      fileSize: Number(row.file_size),
      status: row.document_status ?? row.status
    }
  };
}

export async function findOwnedWorkspace(database, rawToken, workspaceId = null) {
  if (!rawToken) return null;
  const values = [hashToken(rawToken)];
  let idClause = "";
  if (workspaceId) {
    values.push(workspaceId);
    idClause = "AND w.id = $2";
  }
  const result = await database.query(
    `SELECT w.id AS workspace_id, w.document_id, w.original_filename,
            w.current_page, w.zoom, w.ai_action_count,
            w.status AS workspace_status, w.expires_at,
            w.created_at AS workspace_created_at,
            d.file_hash, d.title, d.page_count, d.file_size,
            d.status AS document_status
       FROM paper_workspaces w
       JOIN paper_documents d ON d.id = w.document_id
      WHERE w.owner_token_hash = $1 ${idClause}
      ORDER BY w.created_at DESC
      LIMIT 1`,
    values
  );
  return result.rows[0] || null;
}

export async function extendPaperWorkspace(database, workspaceId, updates = {}) {
  const currentPage = updates.currentPage ?? null;
  const zoom = updates.zoom ?? null;
  const result = await database.query(
    `UPDATE paper_workspaces
        SET current_page = COALESCE($2, current_page),
            zoom = COALESCE($3, zoom),
            last_activity_at = NOW(),
            expires_at = NOW() + ($4 * INTERVAL '1 hour'),
            updated_at = NOW()
      WHERE id = $1
      RETURNING expires_at`,
    [workspaceId, currentPage, zoom, PAPER_EXPIRY_HOURS]
  );
  return result.rows[0]?.expires_at;
}

export async function reservePaperAction(database, workspaceId) {
  const result = await database.query(
    `UPDATE paper_workspaces
        SET ai_action_count = ai_action_count + 1, updated_at = NOW()
      WHERE id = $1 AND ai_action_count < $2
      RETURNING ai_action_count`,
    [workspaceId, PAPER_ACTION_LIMIT]
  );
  return result.rows[0] ? Number(result.rows[0].ai_action_count) : null;
}

export async function refundPaperAction(database, workspaceId) {
  await database.query(
    `UPDATE paper_workspaces
        SET ai_action_count = GREATEST(ai_action_count - 1, 0), updated_at = NOW()
      WHERE id = $1`,
    [workspaceId]
  );
}

export async function deleteExpiredPaperData(database) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const workspaces = await client.query(
      `DELETE FROM paper_workspaces WHERE expires_at <= NOW() RETURNING id`
    );
    await client.query(
      `DELETE FROM paper_documents d
        WHERE NOT EXISTS (
          SELECT 1 FROM paper_workspaces w WHERE w.document_id = d.id
        )
          AND (
            (d.status = 'ready' AND d.updated_at < NOW() - INTERVAL '5 minutes')
            OR (d.status IN ('rejected', 'failed') AND d.updated_at < NOW() - INTERVAL '24 hours')
          )`
    );
    await client.query(
      `DELETE FROM paper_upload_attempts
        WHERE created_at < NOW() - INTERVAL '24 hours'`
    );
    await client.query("COMMIT");
    return workspaces.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
