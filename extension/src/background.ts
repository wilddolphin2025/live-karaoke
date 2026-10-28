// Runs uploads so they survive the popup closing (it closes whenever it loses focus).
import { getAudio, getState, setState, JobState } from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "transcribe") {
    void run(msg.url as string, msg.mime as string);
    reply({ ok: true });
  }
  return false;
});

// Keep the worker alive during long transcriptions (MV3 idles out after ~30s without events).
let keepAlive: ReturnType<typeof setInterval> | undefined;

async function run(url: string, mime: string) {
  const audio = await getAudio();
  if (!audio) return;
  const base: JobState = { phase: "running", fileName: audio.name, startedAt: Date.now() };
  await setState(base);
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": mime }, body: audio.blob });
    const servedBy = r.headers.get("x-served-by") ?? undefined;
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const finishedAt = Date.now();
    if (!r.ok) {
      const hint = r.status === 503 ? " (server busy, try again shortly)" : r.status === 504 ? " (server timed out)" : "";
      await setState({ ...base, phase: "error", finishedAt, servedBy, requestId: data?.request_id,
        error: `Error ${r.status}${hint}: ${data?.err_msg ?? (text.slice(0, 300) || "unknown error")}` +
          (data?.err_code ? `\nCode: ${data.err_code}` : "") + (data?.request_id ? `\nRequest ID: ${data.request_id}` : "") });
      return;
    }
    const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const models = data?.metadata?.models;
    await setState({ ...base, phase: "done", finishedAt, servedBy,
      transcript: alt.transcript ?? "", words: alt.words ?? [], utterances: data?.results?.utterances ?? [],
      model: Array.isArray(models) ? models.join(", ") : models, duration: data?.metadata?.duration,
      requestId: data?.metadata?.request_id });
  } catch (e) {
    await setState({ ...base, phase: "error", finishedAt: Date.now(),
      error: `Network error: could not reach the server (${(e as Error).message}). Check the URL and that the service is up; for https://slim accept the certificate first.` });
  } finally { clearInterval(keepAlive); }
}
