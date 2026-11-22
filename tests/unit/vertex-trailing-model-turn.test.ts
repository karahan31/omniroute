import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripTrailingVertexModelTurn,
  isVertexGeminiTrailingTurnRestrictedModel,
} from "../../open-sse/executors/vertex.ts";

/**
 * Regression test for Vertex AI (aiplatform.googleapis.com) rejecting conversations
 * that end with a `model` turn with:
 * `400 INVALID_ARGUMENT: Requests ending with a model turn are not supported.`
 *
 * Parallels Antigravity's trailing-turn strip (#10104) and ensures Vertex AI
 * native Gemini requests always end on a user turn.
 */

test("(a) strips a single trailing model turn from contents", () => {
  const request = {
    contents: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Hi there" }] },
    ],
  };

  stripTrailingVertexModelTurn(request);

  assert.equal(request.contents.length, 1);
  assert.equal(request.contents[0].role, "user");
});

test("(b) strips multiple consecutive trailing model turns", () => {
  const request = {
    contents: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Turn 1" }] },
      { role: "model", parts: [{ text: "Turn 2" }] },
    ],
  };

  stripTrailingVertexModelTurn(request);

  assert.equal(request.contents.length, 1);
  assert.equal(request.contents[0].role, "user");
});

test("(c) leaves contents ending on user turn untouched", () => {
  const request = {
    contents: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Hi" }] },
      { role: "user", parts: [{ text: "How are you?" }] },
    ],
  };

  stripTrailingVertexModelTurn(request);

  assert.equal(request.contents.length, 3);
  assert.equal(request.contents[2].role, "user");
});

test("(d) preserves a lone model turn so contents is never emptied", () => {
  const request = {
    contents: [{ role: "model", parts: [{ text: "Lone prefill" }] }],
  };

  stripTrailingVertexModelTurn(request);

  assert.equal(request.contents.length, 1);
  assert.equal(request.contents[0].role, "model");
});

test("(e) gracefully handles missing or non-array contents", () => {
  const req1: Record<string, unknown> = {};
  stripTrailingVertexModelTurn(req1);
  assert.deepEqual(req1, {});

  const req2: Record<string, unknown> = { contents: null };
  stripTrailingVertexModelTurn(req2);
  assert.equal(req2.contents, null);
});

test("(f) identifies Gemini 3+ and 4+ chat models as restricted", () => {
  const restricted = [
    "gemini-4-argon",
    "vertex/gemini-4-argon",
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "vertex/gemini-3.8-flash",
    "gemini-3.1-pro-preview",
    "vertex/gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-pro-agent",
  ];
  for (const m of restricted) {
    assert.equal(
      isVertexGeminiTrailingTurnRestrictedModel(m),
      true,
      `Expected ${m} to be restricted from trailing model turns`
    );
  }
});

test("(g) leaves models predating the restriction or outside chat scope unrestricted", () => {
  const unrestricted = [
    "gemini-2.5-flash",
    "vertex/gemini-2.5-flash",
    "gemini-2.5-pro",
    "vertex/gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-image",
    "claude-sonnet-5",
    "vertex/claude-sonnet-5",
    "deepseek-v3.2",
    "qwen3-next-80b",
    "mistral-medium",
  ];
  for (const m of unrestricted) {
    assert.equal(
      isVertexGeminiTrailingTurnRestrictedModel(m),
      false,
      `Expected ${m} to NOT be restricted from trailing model turns`
    );
  }
});

test("(h) regression: prefilled contents reaching a model predating the restriction remains unchanged", () => {
  const legacyModel = "vertex/gemini-2.5-flash";
  const request = {
    contents: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Pre-filled assistant response" }] },
    ],
  };

  // Simulates VertexExecutor.execute boundary check
  if (isVertexGeminiTrailingTurnRestrictedModel(legacyModel)) {
    stripTrailingVertexModelTurn(request);
  }

  assert.equal(request.contents.length, 2, "prefill must be preserved for legacy models");
  assert.equal(request.contents[1].role, "model", "trailing model turn must remain intact");
});
