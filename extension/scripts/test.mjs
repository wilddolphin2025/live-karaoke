// Unit tests for pure logic in src/shared.ts: bundle it with esbuild, then run node:test assertions.
import { build } from "esbuild";
import assert from "node:assert/strict";
import test from "node:test";
const out = "/tmp/parakeet-shared-test.mjs";
await build({ entryPoints: ["src/shared.ts"], bundle: true, format: "esm", platform: "node", outfile: out, define: { __BUILD__: '"test"' }, logLevel: "error" });
const { needsTranslation } = await import(out);
const done = { phase: "done", requestId: "r", sentences: [{ text: "Hola", start: 0, end: 1 }] };
test("ticked before drop: job already translating -> no extra request", () =>
  assert.equal(needsTranslation({ ...done, tr: { target: "en", status: "translating" } }, true, "en"), false));
test("ticked after the transcript finished -> translate", () => assert.equal(needsTranslation(done, true, "en"), true));
test("unticked -> nothing", () => assert.equal(needsTranslation(done, false, "en"), false));
test("target changed -> translate again", () =>
  assert.equal(needsTranslation({ ...done, tr: { target: "en", status: "done" } }, true, "de"), true));
test("failed translation retried on reopen", () =>
  assert.equal(needsTranslation({ ...done, tr: { target: "en", status: "error" } }, true, "en"), true));
test("still transcribing -> wait", () => assert.equal(needsTranslation({ phase: "running" }, true, "en"), false));
