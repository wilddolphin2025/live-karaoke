// Runs uploads so they survive the popup closing (it closes whenever it loses focus).
import { getAudio, getState, setState, JobState } from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "transcribe") {
    void run(msg.url as string, msg.mime as string, msg.translateTo as string | undefined);
    reply({ ok: true });
  }
  return false;
});

// Keep the worker alive during long transcriptions (MV3 idles out after ~30s without events).
let keepAlive: ReturnType<typeof setInterval> | undefined;

// Translate requests get 503 + Retry-After while the cluster switches to translate mode
// (one ASR pod + translator, ~1 min). Retry for up to ~6 minutes.
const WARMING = new Set(["TRANSLATOR_WARMING_UP", "TRANSLATOR_UNAVAILABLE"]);
const MAX_WARM_TRIES = 24;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(url: string, mime: string, translateTo?: string) {
  const audio = await getAudio();
  if (!audio) return;
  const base: JobState = { phase: "running", fileName: audio.name, startedAt: Date.now(), translateTo };
  await setState(base);
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    let r: Response, text: string, data: any = null;
    for (let attempt = 1; ; attempt++) {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": mime }, body: audio.blob });
      text = await r.text();
      data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
      if (!(r.status === 503 && WARMING.has(data?.err_code)) || attempt >= MAX_WARM_TRIES) break;
      const wait = Math.min(60, Math.max(3, Number(r.headers.get("retry-after")) || 15));
      await setState({ ...base, note: `Translator warming up (switching to 1 ASR pod + translator), retry ${attempt}/${MAX_WARM_TRIES - 1} in ${wait}s…` });
      await sleep(wait * 1000);
      await setState({ ...base, note: `Translator warming up, retry ${attempt}/${MAX_WARM_TRIES - 1}…` });
    }
    const servedBy = r.headers.get("x-served-by") ?? undefined;
    const finishedAt = Date.now();
    if (!r.ok) {
      const hint = r.status === 503 && WARMING.has(data?.err_code) ? " (translator did not become ready, try again)" : r.status === 503 ? " (server busy, try again shortly)" : r.status === 504 ? " (server timed out)" : "";
      await setState({ ...base, phase: "error", finishedAt, servedBy, requestId: data?.request_id,
        error: `Error ${r.status}${hint}: ${data?.err_msg ?? (text.slice(0, 300) || "unknown error")}` +
          (data?.err_code ? `\nCode: ${data.err_code}` : "") + (data?.request_id ? `\nRequest ID: ${data.request_id}` : "") });
      return;
    }
    const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const models = data?.metadata?.models;
    await setState({ ...base, phase: "done", finishedAt, servedBy,
      transcript: alt.transcript ?? "", translations: alt.translations, words: alt.words ?? [], utterances: data?.results?.utterances ?? [],
      model: Array.isArray(models) ? models.join(", ") : models, duration: data?.metadata?.duration,
      requestId: data?.metadata?.request_id });
  } catch (e) {
    await setState({ ...base, phase: "error", finishedAt: Date.now(),
      error: `Network error: could not reach the server (${(e as Error).message}). Check the URL and that the service is up; for https://slim accept the certificate first.` });
  } finally { clearInterval(keepAlive); }
}
