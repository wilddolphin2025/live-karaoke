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

// ---- 0.6.1 karaoke highlighting
const { wordAt, KARAOKE_LEAD_S } = await import(out);
const ws = [{ start: 1, end: 1.4 }, { start: 1.5, end: 2 }, { start: 4, end: 4.5 }];
test("karaoke lead is 0.2-0.3 s", () => assert.ok(KARAOKE_LEAD_S >= 0.2 && KARAOKE_LEAD_S <= 0.3));
test("no lead: word at t", () => { assert.equal(wordAt(ws, 1.3), 0); assert.equal(wordAt(ws, 0.9), -1); });
test("lead: next word lights up early", () => { assert.equal(wordAt(ws, 1.3, 0.25), 1); assert.equal(wordAt(ws, 0.8, 0.25), 0); });
test("pause between words: nothing highlighted until the lead", () => { assert.equal(wordAt(ws, 3, 0.25), -1); assert.equal(wordAt(ws, 3.8, 0.25), 2); });

// ---- 0.6.2 toggling Remove vocals on a loaded file
const { sepToggleAction } = await import(out);
const sepDone = { ...done, sep: { base: "", jobId: "j", status: "done", progress: 1, startedAt: 0, downloadUrl: "u" } };
const sepRun = { ...done, sep: { base: "", jobId: "j", status: "separating", progress: 0.3, startedAt: 0 } };
test("off with a finished job -> original (job kept)", () => assert.equal(sepToggleAction(false, sepDone), "original"));
test("off while running -> cancel", () => assert.equal(sepToggleAction(false, sepRun), "cancel"));
test("off before the worker started it -> cancel", () => assert.equal(sepToggleAction(false, { ...done, separate: true }), "cancel"));
test("on with a finished job -> karaoke", () => assert.equal(sepToggleAction(true, sepDone), "karaoke"));
test("on with none -> start", () => assert.equal(sepToggleAction(true, done), "start"));
test("on after a failure -> start again", () => assert.equal(sepToggleAction(true, { ...done, sep: { ...sepRun.sep, status: "error" } }), "start"));
test("on while running -> wait", () => assert.equal(sepToggleAction(true, sepRun), "wait"));
test("no file -> nothing", () => assert.equal(sepToggleAction(true, { phase: "idle" }), "none"));

// ---- 0.7.0 access token + base URL with a path prefix, against a local mock server
import http from "node:http";
const { apiUrl, apiFetch, fetchMediaUrl, resolveServerUrl, authHeaders, AUTH_MSG } = await import(out);
const store = { token: "" };
globalThis.chrome = { storage: { local: { get: async (d) => ({ ...d, ...store }) } } };
const seen = []; let status = 200;
const srv = http.createServer((q, s) => { seen.push({ url: q.url, method: q.method, auth: q.headers.authorization });
  q.resume(); q.on("end", () => { s.writeHead(status, { "Content-Type": q.url.endsWith("/download") ? "audio/mpeg" : "application/json" }); s.end(q.url.endsWith("/download") ? Buffer.alloc(32) : "{}"); }); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const host = `http://127.0.0.1:${srv.address().port}`;
const every = async (base) => {
  seen.length = 0;
  await apiFetch(apiUrl(base, "v1/info"));
  await apiFetch(apiUrl(base, "v1/listen?language=en&utterances=true&paragraphs=true"), { method: "POST", headers: { "Content-Type": "audio/mpeg" }, body: new Blob([new Uint8Array(3)]) });
  await apiFetch(apiUrl(base, "v1/translate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await apiFetch(apiUrl(base, "v1/separate?language=en"), { method: "POST", body: new Blob([new Uint8Array(3)]) });
  await apiFetch(apiUrl(base, "v1/jobs/j1"));
  const s = applyJob({ base: base.replace(/\/+$/, ""), jobId: "j1", status: "muxing", progress: 0, startedAt: 0 }, { status: "done", download_url: "/v1/jobs/j1/download" });
  const blobUrl = await fetchMediaUrl(s.downloadUrl);
  await apiFetch(apiUrl(base, "v1/jobs/j1"), { method: "DELETE" });
  return blobUrl;
};
test("path prefix kept on every endpoint; Bearer on every request incl. media download", async () => {
  store.token = " tok-1 ";
  const blobUrl = await every(`${host}/karaoke/`);
  assert.deepEqual(seen.map((x) => x.url.split("?")[0]), ["/karaoke/v1/info", "/karaoke/v1/listen", "/karaoke/v1/translate", "/karaoke/v1/separate", "/karaoke/v1/jobs/j1", "/karaoke/v1/jobs/j1/download", "/karaoke/v1/jobs/j1"]);
  for (const x of seen) { assert.equal(x.auth, "Bearer tok-1", x.url); assert.ok(!/token/i.test(x.url)); }
  assert.match(blobUrl, /^blob:/);
});
test("no token -> no Authorization header; plain LAN base", async () => {
  store.token = "";
  await every(host);
  assert.equal(seen[0].url, "/v1/info");
  for (const x of seen) assert.equal(x.auth, undefined);
});
test("401/403 on media -> auth message", async () => {
  store.token = "bad";
  for (status of [401, 403]) await assert.rejects(fetchMediaUrl(apiUrl(host, "v1/jobs/j1/download")), { message: AUTH_MSG });
  status = 200;
});
test("url helpers", () => {
  assert.equal(apiUrl("https://rtc.example/karaoke/", "/v1/info"), "https://rtc.example/karaoke/v1/info");
  assert.equal(resolveServerUrl("https://rtc.example/karaoke", "https://other/x"), "https://other/x");
  assert.deepEqual(authHeaders("  "), {});
  srv.close();
});
