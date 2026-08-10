import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { createAiService } from "../src/services/aiService.js";

afterEach(() => mock.restoreAll());

test("AI service errors preserve the upstream detail", async () => {
  mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ detail: "Paper page embedding failed" }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  ));
  const ai = createAiService("http://ai.test");

  await assert.rejects(
    ai.embedPaperPages({ title: "Paper", pages: [] }),
    (error) => {
      assert.equal(error.message, "Paper page embedding failed");
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
});

test("AI service keeps validation status codes", async () => {
  mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ detail: "Question must be related to AI" }),
    { status: 422, headers: { "Content-Type": "application/json" } }
  ));
  const ai = createAiService("http://ai.test");

  await assert.rejects(
    ai.answerPaperQuestion({ question: "unrelated" }),
    (error) => {
      assert.equal(error.message, "Question must be related to AI");
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});
