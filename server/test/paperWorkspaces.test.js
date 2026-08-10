import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { hashToken } from "../src/services/paperWorkspaceService.js";
import { isLocalUploadLimitDisabled } from "../src/routes/paperWorkspaces.js";

class UploadDatabase {
  async query(text) {
    if (text.includes("FROM paper_workspaces w")) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("INSERT INTO paper_upload_attempts")) {
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    if (text.includes("FROM paper_upload_attempts")) {
      return { rowCount: 1, rows: [{ count: 1 }] };
    }
    if (text.includes("COUNT(*)::int AS count FROM paper_workspaces")) {
      return { rowCount: 1, rows: [{ count: 0 }] };
    }
    throw new Error(`Unexpected SQL in paper test: ${text}`);
  }
}

class DuplicateDatabase extends UploadDatabase {
  constructor(hash) {
    super();
    this.hash = hash;
    this.workspace = null;
  }

  async query(text, values = []) {
    if (text.includes("FROM paper_workspaces w") && !this.workspace) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("INSERT INTO paper_workspaces")) {
      this.workspace = {
        workspace_id: values[0],
        document_id: 42,
        original_filename: values[3],
        current_page: 1,
        zoom: 1,
        ai_action_count: 0,
        workspace_status: "ready",
        expires_at: new Date(Date.now() + 86_400_000),
        workspace_created_at: new Date(),
        file_hash: this.hash,
        title: "Cached AI paper",
        page_count: 8,
        file_size: 48,
        document_status: "ready"
      };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("FROM paper_workspaces w") && this.workspace) {
      return { rowCount: 1, rows: [this.workspace] };
    }
    if (text.includes("INSERT INTO paper_documents")) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("FROM paper_documents WHERE file_hash")) {
      return {
        rowCount: 1,
        rows: [{
          id: 42,
          file_hash: this.hash,
          title: "Cached AI paper",
          page_count: 8,
          file_size: 48,
          status: "ready",
          is_ai_related: true,
          relevance_confidence: 0.95,
          relevance_reason: "AI paper",
          updated_at: new Date()
        }]
      };
    }
    return super.query(text, values);
  }
}

function multipartPdf(bytes, boundary = "genradar-boundary") {
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="file"; filename="paper.pdf"\r\n`
        + `Content-Type: application/pdf\r\n\r\n`
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

test("workspace token hashes are deterministic and do not retain the token", () => {
  const token = "a-private-random-workspace-token";
  const expected = createHash("sha256").update(token).digest("hex");
  assert.equal(hashToken(token), expected);
  assert.notEqual(hashToken(token), token);
});

test("PDF upload limits can be bypassed locally but never in production", () => {
  assert.equal(isLocalUploadLimitDisabled({
    NODE_ENV: "development",
    DISABLE_PAPER_UPLOAD_LIMIT: "true"
  }), true);
  assert.equal(isLocalUploadLimitDisabled({
    NODE_ENV: "production",
    DISABLE_PAPER_UPLOAD_LIMIT: "true"
  }), false);
});

test("active paper workspace is null without an ownership cookie", async () => {
  const app = await buildApp({
    logger: false,
    database: new UploadDatabase(),
    aiService: {},
    exaService: {},
    scheduleCleanup: false
  });
  const response = await app.inject({
    method: "GET",
    url: "/api/paper-workspaces/active"
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { workspace: null });
  await app.close();
});

test("paper upload rejects a browser and server hash mismatch", async () => {
  const app = await buildApp({
    logger: false,
    database: new UploadDatabase(),
    aiService: {},
    exaService: {},
    scheduleCleanup: false
  });
  const pdf = multipartPdf(Buffer.from("%PDF-1.4\nnot-a-real-pdf-but-enough-for-hashing"));
  const response = await app.inject({
    method: "POST",
    url: "/api/paper-workspaces",
    headers: {
      "content-type": `multipart/form-data; boundary=${pdf.boundary}`,
      "x-pdf-sha256": "0".repeat(64)
    },
    payload: pdf.payload
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /hashes did not match/i);
  await app.close();
});

test("an exact duplicate reuses the indexed document without AI processing", async () => {
  const bytes = Buffer.from("%PDF-1.4\nexact duplicate paper bytes for hashing");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const database = new DuplicateDatabase(hash);
  let inspectCalls = 0;
  const app = await buildApp({
    logger: false,
    database,
    aiService: {
      async inspectPaper() {
        inspectCalls += 1;
        throw new Error("Duplicate should not be inspected");
      }
    },
    exaService: {},
    scheduleCleanup: false
  });
  const pdf = multipartPdf(bytes);
  const response = await app.inject({
    method: "POST",
    url: "/api/paper-workspaces",
    headers: {
      "content-type": `multipart/form-data; boundary=${pdf.boundary}`,
      "x-pdf-sha256": hash
    },
    payload: pdf.payload
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().workspace.document.id, 42);
  assert.equal(inspectCalls, 0);
  assert.match(response.headers["set-cookie"], /genradar_pdf_workspace=/);
  await app.close();
});
