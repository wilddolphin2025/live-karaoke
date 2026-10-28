// Unit tests for pure logic in src/shared.ts: bundle it with esbuild, then run node:test assertions.
import { build } from "esbuild";
import assert from "node:assert/strict";
import test from "node:test";
const out = "/tmp/parakeet-shared-test.mjs";
await build({ entryPoints: ["src/shared.ts"], bundle: true, format: "esm", platform: "node", outfile: out, define: { __BUILD__: '"test"' }, logLevel: "error" });
const { needsTranslation, summaryText } = await import(out);
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
test("settings chip", () => { assert.equal(summaryText("auto", true, "en"), "auto → en"); assert.equal(summaryText("es", false, "en"), "es"); });

// ---- 0.6.0 vocal removal: strictly opt-in
const { needsSeparation, sepStatusText, applyJob } = await import(out);
test("remove vocals off -> never separate", () => assert.equal(needsSeparation(done, false), false));
test("ticked after the transcript -> separate", () => assert.equal(needsSeparation(done, true), true));
test("requested at drop -> the worker starts it, not the page", () => assert.equal(needsSeparation({ ...done, separate: true }, true), false));
test("already has a job -> no second request", () =>
  assert.equal(needsSeparation({ ...done, sep: { base: "", status: "queued", progress: 0, startedAt: 0 } }, true), false));
test("still transcribing -> wait", () => assert.equal(needsSeparation({ phase: "running" }, true), false));
test("translation in flight -> wait; finished -> go", () => {
  const tr = { target: "en", items: [], done: 0, total: 3, startedAt: 0, status: "translating" };
  assert.equal(needsSeparation({ ...done, translateTo: "en", tr }, true), false);
  assert.equal(needsSeparation({ ...done, translateTo: "en", tr: { ...tr, status: "done" } }, true), true);
});
test("job status mapping + status text", () => {
  let s = { base: "http://x", jobId: "j", status: "queued", progress: 0, startedAt: 0 };
  s = applyJob(s, { status: "separating", progress: 0.42, device: "cuda", model: "htdemucs_ft", stage: "separating" });
  assert.equal(sepStatusText(s), "Removing vocals on CUDA: 42%");
  s = applyJob(s, { status: "done", progress: 1, download_url: "/v1/jobs/j/download", is_video: true, result: { words: [{ word: "la", start: 1, end: 2 }] } });
  assert.equal(s.downloadUrl, "http://x/v1/jobs/j/download"); assert.equal(s.words.length, 1); assert.equal(s.isVideo, true);
  assert.match(sepStatusText({ ...s, finishedAt: 60000 }), /^Instrumental ready in 60s \(htdemucs_ft on CUDA\)$/);
  s = applyJob(s, { status: "failed", error: { err_msg: "boom" } });
  assert.equal(sepStatusText(s), "Vocal removal failed: boom");
});
test("settings chip shows vocal removal", () => assert.equal(summaryText("auto", false, "en", true), "auto · no vocals"));
