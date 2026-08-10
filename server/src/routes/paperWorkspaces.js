import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { loadPaperWorkspace } from "../prehandlers.js";
import {
  activePaperWorkspaceSchema,
  askPaperQuestionSchema,
  createPaperWorkspaceSchema,
  deletePaperWorkspaceSchema,
  explainPaperFigureSchema,
  explainPaperSelectionSchema,
  getPaperWorkspaceSchema,
  updatePaperReaderSchema
} from "../schemas.js";
import {
  createOwnerToken,
  deleteExpiredPaperData,
  extendPaperWorkspace,
  findOwnedWorkspace,
  hashIp,
  mapPaperWorkspace,
  paperCookieOptions,
  PAPER_ACTION_LIMIT,
  PAPER_COOKIE,
  PAPER_EXPIRY_HOURS,
  refundPaperAction,
  reservePaperAction
} from "../services/paperWorkspaceService.js";
import { vectorLiteral } from "../services/vectorSearchService.js";
import { deleteExpiredChats } from "../services/chatCleanupService.js";

const MAX_PDF_BYTES = Number(process.env.PAPER_MAX_BYTES || 20 * 1024 * 1024);
const MAX_ACTIVE_WORKSPACES = Number(process.env.PAPER_ACTIVE_WORKSPACE_LIMIT || 100);
const UPLOAD_LIMIT = Number(process.env.PAPER_UPLOAD_LIMIT || 3);
const AI_REQUEST_LIMIT = Number(process.env.PAPER_AI_REQUEST_LIMIT || 30);
const RELEVANCE_THRESHOLD = Number(process.env.PAPER_RELEVANCE_THRESHOLD || 0.70);

export function isLocalUploadLimitDisabled(environment = process.env) {
  return environment.NODE_ENV !== "production"
    && environment.DISABLE_PAPER_UPLOAD_LIMIT === "true";
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeFilename(value) {
  return basename(value || "paper.pdf").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 240);
}

function setWorkspaceCookie(reply, token, expiresAt) {
  reply.setCookie(PAPER_COOKIE, token, paperCookieOptions(expiresAt));
}

async function loadWorkspaceRow(database, workspaceId) {
  const result = await database.query(
    `SELECT w.id AS workspace_id, w.document_id, w.original_filename,
            w.current_page, w.zoom, w.ai_action_count,
            w.status AS workspace_status, w.expires_at,
            w.created_at AS workspace_created_at,
            d.file_hash, d.title, d.page_count, d.file_size,
            d.status AS document_status
       FROM paper_workspaces w
       JOIN paper_documents d ON d.id = w.document_id
      WHERE w.id = $1`,
    [workspaceId]
  );
  return result.rows[0];
}

async function createWorkspace(fastify, document, filename, reply) {
  const owner = createOwnerToken();
  const id = randomUUID();
  await fastify.db.query(
    `INSERT INTO paper_workspaces
       (id, document_id, owner_token_hash, original_filename, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 hour'))`,
    [id, document.id, owner.hash, filename, document.status, PAPER_EXPIRY_HOURS]
  );
  const row = await loadWorkspaceRow(fastify.db, id);
  setWorkspaceCookie(reply, owner.token, row.expires_at);
  return mapPaperWorkspace(row);
}

async function recordUploadAttempt(fastify, request) {
  if (isLocalUploadLimitDisabled()) return null;

  const ipHash = hashIp(request.ip);
  const inserted = await fastify.db.query(
    `INSERT INTO paper_upload_attempts (ip_hash) VALUES ($1) RETURNING id`,
    [ipHash]
  );
  const result = await fastify.db.query(
    `SELECT COUNT(*)::int AS count
       FROM paper_upload_attempts
      WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [ipHash]
  );
  if (Number(result.rows[0].count) > UPLOAD_LIMIT) {
    throw httpError(
      `This IP has reached its ${UPLOAD_LIMIT}-paper upload limit for 24 hours`,
      429
    );
  }
  return inserted.rows[0].id;
}

async function receivePdf(request) {
  const part = await request.file({
    limits: { files: 1, fileSize: MAX_PDF_BYTES, fields: 0 }
  });
  if (!part) throw httpError("A PDF file is required", 400);
  if (part.mimetype !== "application/pdf") {
    throw httpError("Only PDF files are supported", 400);
  }
  const filename = safeFilename(part.filename);
  const path = join(tmpdir(), `genradar-paper-${randomUUID()}.pdf`);
  const hasher = createHash("sha256");
  let size = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hasher.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(part.file, hashingStream, createWriteStream(path, { flags: "wx" }));
    if (part.file.truncated || size > MAX_PDF_BYTES) {
      throw httpError("PDF exceeds the 20 MB limit", 413);
    }
    if (size === 0) throw httpError("The uploaded PDF is empty", 400);
    return { path, filename, size, hash: hasher.digest("hex") };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

async function findDocument(database, hash) {
  const result = await database.query(
    `SELECT id, file_hash, title, page_count, file_size, status,
            is_ai_related, relevance_confidence, relevance_reason, updated_at
       FROM paper_documents WHERE file_hash = $1`,
    [hash]
  );
  return result.rows[0] || null;
}

async function claimDocument(database, hash, size) {
  const inserted = await database.query(
    `INSERT INTO paper_documents (file_hash, file_size, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT (file_hash) DO NOTHING
     RETURNING id, file_hash, title, page_count, file_size, status`,
    [hash, size]
  );
  if (inserted.rows[0]) return { document: inserted.rows[0], claimed: true };
  let document = await findDocument(database, hash);
  if (document?.status === "processing"
      && new Date(document.updated_at).getTime() < Date.now() - 10 * 60 * 1000) {
    const reclaimed = await database.query(
      `UPDATE paper_documents
          SET updated_at = NOW()
        WHERE id = $1 AND status = 'processing'
          AND updated_at < NOW() - INTERVAL '10 minutes'
        RETURNING id, file_hash, title, page_count, file_size, status`,
      [document.id]
    );
    if (reclaimed.rows[0]) return { document: reclaimed.rows[0], claimed: true };
    document = await findDocument(database, hash);
  }
  if (document?.status === "failed") {
    const reclaimed = await database.query(
      `UPDATE paper_documents
          SET status = 'processing', updated_at = NOW()
        WHERE id = $1 AND status = 'failed'
        RETURNING id, file_hash, title, page_count, file_size, status`,
      [document.id]
    );
    if (reclaimed.rows[0]) return { document: reclaimed.rows[0], claimed: true };
    document = await findDocument(database, hash);
  }
  return { document, claimed: false };
}

async function processDocument(fastify, document, upload) {
  try {
    const inspection = await fastify.ai.inspectPaper(
      upload.filename,
      await readFile(upload.path)
    );
    const relevance = inspection.relevance;
    if (!relevance.isAiRelated || relevance.confidence < RELEVANCE_THRESHOLD) {
      await fastify.db.query(
        `UPDATE paper_documents
            SET title = $2, page_count = $3, status = 'rejected',
                is_ai_related = $4, relevance_confidence = $5,
                relevance_reason = $6, updated_at = NOW()
          WHERE id = $1`,
        [document.id, inspection.title, inspection.pageCount,
          relevance.isAiRelated, relevance.confidence, relevance.reason]
      );
      await fastify.db.query(
        `UPDATE paper_workspaces SET status = 'rejected', updated_at = NOW()
          WHERE document_id = $1 AND status = 'processing'`,
        [document.id]
      );
      throw httpError(
        relevance.reason || "Only AI-related white papers are supported",
        422
      );
    }

    // Persist inspection before embedding so a later provider failure remains
    // diagnosable and the failed document can be reclaimed on the next upload.
    await fastify.db.query(
      `UPDATE paper_documents
          SET title = $2, page_count = $3, is_ai_related = TRUE,
              relevance_confidence = $4, relevance_reason = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [document.id, inspection.title, inspection.pageCount,
        relevance.confidence, relevance.reason]
    );

    // Python still sends bounded provider batches, but receives the complete
    // paper at once so it can fill each batch instead of making one request
    // for every small page group. This matters on low-RPM embedding quotas.
    const embedded = await fastify.ai.embedPaperPages({
      title: inspection.title,
      pages: inspection.pages
    });
    const embeddedChunks = embedded.chunks;

    const client = await fastify.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM paper_pages WHERE document_id = $1`, [document.id]);
      await client.query(`DELETE FROM paper_chunks WHERE document_id = $1`, [document.id]);
      await client.query(
        `INSERT INTO paper_pages
           (document_id, page_number, page_text, character_count)
         SELECT $1, page_number, page_text, character_count
           FROM UNNEST($2::int[], $3::text[], $4::int[])
             AS page(page_number, page_text, character_count)`,
        [
          document.id,
          inspection.pages.map((page) => page.pageNumber),
          inspection.pages.map((page) => page.text),
          inspection.pages.map((page) => page.text.length)
        ]
      );
      for (let index = 0; index < embeddedChunks.length; index += 100) {
        const batch = embeddedChunks.slice(index, index + 100);
        await client.query(
          `INSERT INTO paper_chunks
             (document_id, page_number, chunk_index, content, embedding)
           SELECT $1, page_number, chunk_index, content, embedding_text::vector
             FROM UNNEST($2::int[], $3::int[], $4::text[], $5::text[])
               AS chunk(page_number, chunk_index, content, embedding_text)`,
          [
            document.id,
            batch.map((chunk) => chunk.pageNumber),
            batch.map((chunk) => chunk.chunkIndex),
            batch.map((chunk) => chunk.content),
            batch.map((chunk) => vectorLiteral(chunk.embedding))
          ]
        );
      }
      await client.query(
        `UPDATE paper_documents
            SET title = $2, page_count = $3, status = 'ready',
                is_ai_related = TRUE, relevance_confidence = $4,
                relevance_reason = $5, updated_at = NOW()
          WHERE id = $1`,
        [document.id, inspection.title, inspection.pageCount,
          relevance.confidence, relevance.reason]
      );
      await client.query(
        `UPDATE paper_workspaces SET status = 'ready', updated_at = NOW()
          WHERE document_id = $1 AND status = 'processing'`,
        [document.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return findDocument(fastify.db, document.file_hash);
  } catch (error) {
    if (error.statusCode !== 422) {
      await fastify.db.query(
        `UPDATE paper_documents SET status = 'failed', updated_at = NOW()
          WHERE id = $1`,
        [document.id]
      );
      await fastify.db.query(
        `UPDATE paper_workspaces SET status = 'failed', updated_at = NOW()
          WHERE document_id = $1 AND status = 'processing'`,
        [document.id]
      );
    }
    throw error;
  }
}

async function ensureReady(request, reply) {
  if (request.paperWorkspace.document.status !== "ready") {
    return reply.code(409).send({ message: "This paper is still being processed" });
  }
}

async function beginAction(fastify, request, reply) {
  const count = await reservePaperAction(fastify.db, request.paperWorkspace.id);
  if (count === null) {
    reply.code(429).send({
      message: `This workspace has reached its ${PAPER_ACTION_LIMIT}-action limit`
    });
    return null;
  }
  return count;
}

async function finishAction(fastify, request, reply, count) {
  const expiresAt = await extendPaperWorkspace(fastify.db, request.paperWorkspace.id);
  setWorkspaceCookie(reply, request.cookies[PAPER_COOKIE], expiresAt);
  return { expiresAt, aiActionCount: count };
}

async function refundForServerFailure(fastify, request, error) {
  if ((error.statusCode || 500) >= 500) {
    await refundPaperAction(fastify.db, request.paperWorkspace.id);
  }
}

async function paperPageContext(database, documentId, pageNumber) {
  const result = await database.query(
    `SELECT page_number, page_text FROM paper_pages
      WHERE document_id = $1 AND page_number BETWEEN $2 AND $3
      ORDER BY page_number`,
    [documentId, Math.max(1, pageNumber - 1), pageNumber + 1]
  );
  return result.rows;
}

async function retrievePaperChunks(database, documentId, embedding, limit = 5) {
  const result = await database.query(
    `SELECT id, page_number, content,
            1 - (embedding <=> $2::vector) AS similarity
       FROM paper_chunks
      WHERE document_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [documentId, vectorLiteral(embedding), limit]
  );
  return result.rows;
}

export default async function paperWorkspaceRoutes(fastify) {
  fastify.post("/api/paper-workspaces", {
    schema: createPaperWorkspaceSchema,
    bodyLimit: MAX_PDF_BYTES + 1024 * 128
  }, async (request, reply) => {
    const existingOwned = await findOwnedWorkspace(
      fastify.db,
      request.cookies?.[PAPER_COOKIE]
    );
    if (existingOwned && new Date(existingOwned.expires_at) > new Date()) {
      return reply.code(409).send({
        message: "Delete your current PDF workspace before uploading another paper"
      });
    }
    let upload;
    let uploadAttemptId;
    try {
      uploadAttemptId = await recordUploadAttempt(fastify, request);
      const capacity = await fastify.db.query(
        `SELECT COUNT(*)::int AS count FROM paper_workspaces WHERE expires_at > NOW()`
      );
      if (Number(capacity.rows[0].count) >= MAX_ACTIVE_WORKSPACES) {
        throw httpError("Paper workspace capacity is currently full", 503);
      }
      upload = await receivePdf(request);
      const browserHash = request.headers["x-pdf-sha256"].toLowerCase();
      if (upload.hash !== browserHash) {
        throw httpError("Browser and server PDF hashes did not match", 400);
      }
      const claim = await claimDocument(fastify.db, upload.hash, upload.size);
      if (claim.document.status === "rejected" && !claim.claimed) {
        throw httpError(
          claim.document.relevance_reason || "Only AI-related white papers are supported",
          422
        );
      }
      if (claim.document.status === "processing" && !claim.claimed) {
        const workspace = await createWorkspace(
          fastify, claim.document, upload.filename, reply
        );
        return reply.code(202).send({ workspace });
      }
      const document = claim.claimed
        ? await processDocument(fastify, claim.document, upload)
        : claim.document;
      const workspace = await createWorkspace(
        fastify, document, upload.filename, reply
      );
      return reply.code(201).send({ workspace });
    } catch (error) {
      if (uploadAttemptId && Number(error.statusCode) >= 500) {
        await fastify.db.query(
          `DELETE FROM paper_upload_attempts WHERE id = $1`,
          [uploadAttemptId]
        ).catch(() => {});
      }
      throw error;
    } finally {
      if (upload?.path) await unlink(upload.path).catch(() => {});
    }
  });

  fastify.get("/api/paper-workspaces/active", {
    schema: activePaperWorkspaceSchema
  }, async (request, reply) => {
    const row = await findOwnedWorkspace(
      fastify.db,
      request.cookies?.[PAPER_COOKIE]
    );
    if (!row || new Date(row.expires_at) <= new Date()) {
      reply.clearCookie(PAPER_COOKIE, { path: "/" });
      return { workspace: null };
    }
    return { workspace: mapPaperWorkspace(row) };
  });

  fastify.get("/api/paper-workspaces/:workspaceId", {
    schema: getPaperWorkspaceSchema,
    preHandler: loadPaperWorkspace
  }, async (request) => ({ workspace: request.paperWorkspace }));

  fastify.patch("/api/paper-workspaces/:workspaceId/reader-state", {
    schema: updatePaperReaderSchema,
    preHandler: loadPaperWorkspace
  }, async (request, reply) => {
    if (request.body.currentPage
        && request.body.currentPage > request.paperWorkspace.document.pageCount) {
      return reply.code(422).send({ message: "Page not found" });
    }
    const expiresAt = await extendPaperWorkspace(
      fastify.db,
      request.paperWorkspace.id,
      request.body
    );
    setWorkspaceCookie(reply, request.cookies[PAPER_COOKIE], expiresAt);
    return { expiresAt };
  });

  fastify.post("/api/paper-workspaces/:workspaceId/explain-selection", {
    schema: explainPaperSelectionSchema,
    preHandler: [loadPaperWorkspace, ensureReady],
    config: { rateLimit: { max: AI_REQUEST_LIMIT, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    let count = null;
    try {
      const { pageNumber, selectedText } = request.body;
      const pages = await paperPageContext(
        fastify.db, request.paperWorkspace.document.id, pageNumber
      );
      const current = pages.find((page) => Number(page.page_number) === pageNumber);
      if (!current) return reply.code(422).send({ message: "Page not found" });
      count = await beginAction(fastify, request, reply);
      if (count === null) return;
      const sections = pages.map((page) => (
        `PAGE ${page.page_number}:\n${page.page_text}`
      ));
      const combined = sections.join("\n\n");
      const currentIndex = pages.indexOf(current);
      const currentOffset = sections
        .slice(0, currentIndex)
        .reduce((total, section) => total + section.length + 2, 0)
        + `PAGE ${current.page_number}:\n`.length;
      const currentPosition = current.page_text
        .toLowerCase()
        .indexOf(selectedText.toLowerCase());
      const position = currentPosition >= 0 ? currentOffset + currentPosition : -1;
      const surroundingContext = position >= 0
        ? combined.slice(Math.max(0, position - 2000), position + selectedText.length + 2000)
        : combined.slice(0, 12000);
      const ambiguous = selectedText.length < 300
        || /\b(this|that|these|those|it|they|the method|the approach|the model)\b/i.test(selectedText)
        || position < 0;
      let additionalEvidence = [];
      if (ambiguous) {
        const query = await fastify.ai.embedPaperQuery(selectedText);
        const chunks = await retrievePaperChunks(
          fastify.db, request.paperWorkspace.document.id, query.embedding, 3
        );
        additionalEvidence = chunks.map((chunk) => ({
          pageNumber: Number(chunk.page_number), text: chunk.content
        }));
      }
      const explanation = await fastify.ai.explainPaperSelection({
        paperTitle: request.paperWorkspace.document.title,
        pageNumber,
        selectedText,
        surroundingContext,
        additionalEvidence
      });
      const activity = await finishAction(fastify, request, reply, count);
      return { explanation, ...activity };
    } catch (error) {
      if (count !== null) await refundForServerFailure(fastify, request, error);
      throw error;
    }
  });

  fastify.post("/api/paper-workspaces/:workspaceId/explain-figure", {
    schema: explainPaperFigureSchema,
    bodyLimit: 7_500_000,
    preHandler: [loadPaperWorkspace, ensureReady],
    config: { rateLimit: { max: AI_REQUEST_LIMIT, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const match = request.body.imageDataUrl.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/
    );
    if (!match) return reply.code(400).send({ message: "Invalid figure image" });
    const imageBytes = Buffer.from(match[2], "base64");
    if (imageBytes.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ message: "Figure crop exceeds 5 MB" });
    }
    let count = null;
    try {
      const pages = await paperPageContext(
        fastify.db,
        request.paperWorkspace.document.id,
        request.body.pageNumber
      );
      const pageContext = pages.map((page) => page.page_text).join("\n\n").slice(0, 8000);
      if (!pageContext) return reply.code(422).send({ message: "Page not found" });
      count = await beginAction(fastify, request, reply);
      if (count === null) return;
      const explanation = await fastify.ai.explainPaperFigure({
        paperTitle: request.paperWorkspace.document.title,
        pageNumber: request.body.pageNumber,
        pageContext,
        imageBase64: match[2],
        mimeType: match[1]
      });
      const activity = await finishAction(fastify, request, reply, count);
      return { explanation, ...activity };
    } catch (error) {
      if (count !== null) await refundForServerFailure(fastify, request, error);
      throw error;
    }
  });

  fastify.post("/api/paper-workspaces/:workspaceId/questions", {
    schema: askPaperQuestionSchema,
    preHandler: [loadPaperWorkspace, ensureReady],
    config: { rateLimit: { max: AI_REQUEST_LIMIT, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const count = await beginAction(fastify, request, reply);
    if (count === null) return;
    try {
      const firstPage = await fastify.db.query(
        `SELECT page_text FROM paper_pages
          WHERE document_id = $1 ORDER BY page_number LIMIT 1`,
        [request.paperWorkspace.document.id]
      );
      const scope = await fastify.ai.checkQuestionScope({
        question: request.body.question,
        articleTitle: request.paperWorkspace.document.title,
        articleContext: (firstPage.rows[0]?.page_text || "").slice(0, 4000),
        conversationSummary: "",
        recentMessages: []
      });
      if (scope.action !== "continue") {
        await refundPaperAction(fastify.db, request.paperWorkspace.id);
        return reply.code(422).send({
          message: scope.action === "rephrase"
            ? "Please rephrase this as an AI-related question"
            : "Questions in the paper reader must relate to AI"
        });
      }
      let chunks = [];
      if (request.body.answerMode === "paper") {
        const query = await fastify.ai.embedPaperQuery(request.body.question);
        chunks = await retrievePaperChunks(
          fastify.db, request.paperWorkspace.document.id, query.embedding, 5
        );
      }
      const answer = await fastify.ai.answerPaperQuestion({
        question: request.body.question,
        paperTitle: request.paperWorkspace.document.title,
        requestedAnswerMode: request.body.answerMode,
        evidence: chunks.map((chunk) => ({
          id: `paper-${chunk.id}`,
          pageNumber: Number(chunk.page_number),
          content: chunk.content
        }))
      });
      const activity = await finishAction(fastify, request, reply, count);
      return { answer, ...activity };
    } catch (error) {
      await refundForServerFailure(fastify, request, error);
      throw error;
    }
  });

  fastify.delete("/api/paper-workspaces/:workspaceId", {
    schema: deletePaperWorkspaceSchema,
    preHandler: loadPaperWorkspace
  }, async (request, reply) => {
    const documentId = request.paperWorkspace.document.id;
    await fastify.db.query(`DELETE FROM paper_workspaces WHERE id = $1`, [request.paperWorkspace.id]);
    await fastify.db.query(
      `DELETE FROM paper_documents d
        WHERE d.id = $1 AND d.status <> 'processing'
          AND NOT EXISTS (SELECT 1 FROM paper_workspaces w WHERE w.document_id = d.id)`,
      [documentId]
    );
    reply.clearCookie(PAPER_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  fastify.post("/api/internal/cleanup-expired", async (request, reply) => {
    if (!process.env.CLEANUP_API_KEY
        || request.headers["x-cleanup-key"] !== process.env.CLEANUP_API_KEY) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    const deletedPaperWorkspaces = await deleteExpiredPaperData(fastify.db);
    const deletedChats = await deleteExpiredChats(fastify.db);
    return { deletedPaperWorkspaces, deletedChats };
  });
}
