// Remove-vocals flow against scripts/sep_mock.py (no GPU needed).
// Usage: CHROME=... node scripts/sep_e2e.mjs <dist> <media file> on|off   (mock on SEP_MOCK, default http://192.168.8.226:18998)
import puppeteer from "puppeteer-core";
const [ext, file, tick] = [process.argv[2], process.argv[3], process.argv[4] === "on"];
const MOCK = process.env.SEP_MOCK || "http://192.168.8.226:18998";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
let code = 1;
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker");
  const id = new URL(sw.url()).host;
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`chrome-extension://${id}/app.html`); await page.waitForSelector("#sep");
  console.log("default Remove vocals:", await page.$eval("#sep", (e) => e.checked));
  await page.click("#gear"); await page.$eval("#server", (e, m) => { e.value = m; e.dispatchEvent(new Event("change")); }, MOCK);
  if (tick) await page.click("#sep");
  await page.click("#back"); await new Promise((r) => setTimeout(r, 300));
  await (await page.$("#file")).uploadFile(file);
  const ui = () => page.evaluate(() => {
    const p = [...document.querySelectorAll("audio,video")].find((e) => !e.hidden);
    return { bar: !document.querySelector("#sepbar").hidden, st: document.querySelector("#sepstatus").textContent,
      dl: document.querySelector("#sepdl").hidden ? null : document.querySelector("#sepdl").href,
      mode: document.querySelector("#sepmode").hidden ? null : document.querySelector("#sepmode").textContent,
      player: p ? { tag: p.tagName, src: p.src.startsWith("blob:") ? "blob(original)" : p.src, t: +p.currentTime.toFixed(2), paused: p.paused } : null,
      karaoke: document.body.classList.contains("karaoke"), cur: document.querySelector(".w.cur")?.textContent ?? null,
      line: !!document.querySelector(".line"), h: document.body.offsetHeight, w: document.body.offsetWidth };
  });
  // Start playing the original before the job finishes: the swap must keep position and play state.
  await page.waitForFunction(() => [...document.querySelectorAll("audio,video")].some((e) => !e.hidden && e.readyState >= 1), { timeout: 10000 });
  await page.evaluate(() => { const p = [...document.querySelectorAll("audio,video")].find((e) => !e.hidden); p.muted = true; p.currentTime = 0.5; return p.play(); });
  let u, before = 0, after = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000)); u = await ui(); console.log(JSON.stringify(u));
    if (u.player?.src === "blob(original)") before = u.player.t; else if (after === null && u.player) after = u.player.t;
  }
  console.log(`position: last original sample ${before}s, first karaoke sample ${after}s`);
  if (tick) {
    const ok = u.player.src === u.dl && !u.player.paused && after !== null && after >= before && u.karaoke && u.mode === "🎤 Original" && u.line && u.h === 600 && u.w === 400;
    console.log(ok ? "PASS auto-replace: karaoke media playing from the same position, stem highlighting" : "FAIL auto-replace");
    await page.click("#sepmode"); await new Promise((r) => setTimeout(r, 800));
    const o = await ui(); console.log("after Original:", JSON.stringify(o));
    const ok2 = o.player.src === "blob(original)" && !o.player.paused && !o.karaoke && o.mode === "🎶 Instrumental";
    console.log(ok2 ? "PASS Original toggle" : "FAIL Original toggle");
    code = ok && ok2 ? 0 : 1;
  } else code = u.bar || u.dl ? 1 : 0;
  await page.click("#clear"); await new Promise((r) => setTimeout(r, 800));
  console.log("after clear:", JSON.stringify(await ui()), JSON.stringify(await page.evaluate(async () => (await chrome.storage.session.get("job")).job)));
} finally { await browser.close(); process.exit(code); }
