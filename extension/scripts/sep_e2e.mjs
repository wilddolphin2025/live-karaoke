// Remove-vocals / karaoke flow. Works against scripts/sep_mock.py or the live service (0.7.0+).
// Usage: CHROME=... SEP_SERVER=http://<mock-host>:18998 node scripts/sep_e2e.mjs <dist> <media file> <scenario> [timeout s]
//   on      tick before drop: job runs after the transcript, karaoke replaces the playing media (same position),
//           untick -> original at the same position, tick -> karaoke again, reopen popup -> media restored, Clear -> DELETE
//   off     never ticked: no separation request, no karaoke row
//   late    drop unticked, tick after the transcript: separation starts for the loaded file
//   cancel  tick, drop, untick while the job runs: job cancelled, original keeps playing, no karaoke row
import puppeteer from "puppeteer-core";
const [ext, file, scenario] = [process.argv[2], process.argv[3], process.argv[4] || "on"], LIMIT = Number(process.argv[5] || 60) * 1000;
const SERVER = process.env.SEP_SERVER || process.env.SEP_MOCK || "http://localhost:18998";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) fails++; };
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker");
  const id = new URL(sw.url()).host;
  const open = async () => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(`chrome-extension://${id}/app.html`); await page.waitForSelector("#sep"); await sleep(400);
    return page;
  };
  let page = await open();
  check(!(await page.$eval("#sep", (e) => e.checked)), "Remove vocals off by default");
  await page.click("#gear"); await page.$eval("#server", (e, m) => { e.value = m; e.dispatchEvent(new Event("change")); }, SERVER);
  await page.click("#back");
  const setSep = async (on) => { await page.click("#gear"); if ((await page.$eval("#sep", (e) => e.checked)) !== on) await page.click("#sep"); await page.click("#back"); };
  const ui = () => page.evaluate(() => {
    const p = [...document.querySelectorAll("audio,video")].find((e) => !e.hidden);
    return { bar: !document.querySelector("#sepbar").hidden, st: document.querySelector("#sepstatus").textContent,
      dl: document.querySelector("#sepdl").hidden ? null : document.querySelector("#sepdl").href,
      mode: document.querySelector("#sepmode").hidden ? null : document.querySelector("#sepmode").textContent,
      player: p ? { tag: p.tagName, src: p.src.startsWith("blob:") ? "original" : p.src.startsWith("http") ? "karaoke" : p.src, t: +p.currentTime.toFixed(2), paused: p.paused, seekable: p.seekable.length ? +p.seekable.end(0).toFixed(1) : 0 } : null,
      karaoke: document.body.classList.contains("karaoke"), cur: document.querySelector(".w.cur")?.textContent ?? null,
      line: !!document.querySelector(".line"), hw: `${document.body.offsetHeight}x${document.body.offsetWidth}` };
  });
  const job = () => page.evaluate(async () => (await chrome.storage.session.get("job")).job ?? {});
  const until = async (pred, what) => { const t0 = Date.now(); while (Date.now() - t0 < LIMIT) { const u = await ui(); if (pred(u, await job())) return u; await sleep(500); } console.log("timeout:", what, JSON.stringify(await ui())); return ui(); };
  const play = (t) => page.evaluate((t) => { const p = [...document.querySelectorAll("audio,video")].find((e) => !e.hidden); p.muted = true; if (t != null) p.currentTime = t; return p.play(); }, t);
  // Seamless swap: the position right after must be >= the position right before (and not far ahead).
  const swapped = async (to, action, what) => {
    const b = (await ui()).player; await action();
    const a = await until((u) => u.player?.src === to && u.player.t > 0, what);
    console.log(`  ${what}: ${b.src} ${b.t}s ${b.paused ? "paused" : "playing"} -> ${a.player.src} ${a.player.t}s ${a.player.paused ? "paused" : "playing"}`);
    check(a.player.src === to && a.player.t >= b.t - 0.05 && a.player.t < b.t + 3 && a.player.paused === b.paused, what + " keeps position and play state");
    return a;
  };

  if (scenario === "on" || scenario === "cancel") await setSep(true);
  await (await page.$("#file")).uploadFile(file);
  await until((u, j) => j.phase === "done" && u.player, "transcript");
  await play(0.5);
  if (scenario === "off") {
    await sleep(8000); const u = await ui();
    check(!u.bar && u.player.src === "original" && !(await job()).sep, "no separation without opt-in");
  }
  if (scenario === "late") {
    await sleep(1000); await setSep(true);
    const u = await until((u, j) => !!j.sep, "job started after tick");
    check(u.bar, "ticking after the transcript starts a separation for the loaded file");
    await until((u) => u.player?.src === "karaoke", "karaoke");
    check((await ui()).karaoke, "karaoke after late tick");
  }
  if (scenario === "cancel") {
    await until((u, j) => j.sep?.jobId, "job queued");
    const jid = (await job()).sep.jobId;
    await sleep(1500); await setSep(false);
    const u = await until((u, j) => !j.sep && !u.bar, "cancelled");
    check(!u.bar && u.player.src === "original" && !u.player.paused, `untick while running cancels job ${jid}; original keeps playing`);
    const r = await page.evaluate(async (s, j) => (await fetch(`${s}/v1/jobs/${j}`)).status, SERVER, jid);
    check(r === 404, `server job gone after cancel (GET -> ${r})`);
    await sleep(4000); check(!(await job()).sep && (await ui()).player.src === "original", "no karaoke swap after cancel");
  }
  if (scenario === "on") {
    // Wait for the job, sampling the original right before the automatic swap.
    let before = null;
    const t0 = Date.now();
    for (;;) { const u = await ui(); if (u.player.src === "karaoke") { console.log(`  auto: original ${before?.t}s -> karaoke ${u.player.t}s, ${(await job()).sep?.status}`);
        check(u.player.t >= (before?.t ?? 0) - 0.05 && !u.player.paused, "auto-replace keeps position, still playing"); break; }
      before = u.player; if (Date.now() - t0 > LIMIT) { check(false, "job finished in time: " + JSON.stringify(u)); break; } await sleep(250); }
    let u = await until((u) => u.player.seekable > 0, "seekable");
    console.log("  karaoke:", JSON.stringify(u));
    check(u.karaoke && u.mode === "🎤 Original" && !!u.dl && u.hw === "600x400", "karaoke mode, Original toggle + Download shown, 600x400");
    await page.evaluate(() => { const p = [...document.querySelectorAll("audio,video")].find((e) => !e.hidden); p.currentTime = Math.min(20, p.seekable.end(0) - 6); });
    await sleep(1500);
    check((await ui()).player.t >= 19 || (await ui()).player.t >= (await ui()).player.seekable - 7 || (await ui()).player.seekable < 22, `seek inside the karaoke file works (t=${(await ui()).player.t}, seekable to ${(await ui()).player.seekable})`);
    u = await swapped("original", () => setSep(false), "untick Remove vocals -> original");
    check(!u.bar && !u.karaoke, "untick hides the karaoke row, normal highlighting");
    u = await swapped("karaoke", () => setSep(true), "tick again -> karaoke (existing job, no new request)");
    check(u.karaoke && u.bar, "karaoke row back");
    await page.evaluate(() => [...document.querySelectorAll("audio,video")].find((e) => !e.hidden).pause());
    u = await swapped("original", () => setSep(false), "untick while paused -> original");
    // Reopen: original media must come back from IndexedDB (setting off), karaoke when on.
    await page.close(); page = await open();
    u = await until((u) => u.player, "reopen");
    check(u.player.src === "original" && !u.bar, "reopen with the setting off: original media restored");
    await setSep(true);
    u = await until((u) => u.player?.src === "karaoke", "karaoke after reopen");
    check(u.player.src === "karaoke" && u.karaoke, "reopen + tick: karaoke again");
    await page.close(); page = await open();
    u = await until((u) => u.player?.src === "karaoke", "reopen with the setting on");
    check(u.player.src === "karaoke", "reopen with the setting on: karaoke media");
    const jid = (await job()).sep.jobId;
    await page.click("#clear"); await sleep(1000);
    const r = await page.evaluate(async (s, j) => (await fetch(`${s}/v1/jobs/${j}`)).status, SERVER, jid);
    check(r === 404 && (await job()).phase === "idle", `Clear deletes job ${jid} (GET -> ${r})`);
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
} finally { await browser.close(); process.exit(fails ? 1 : 0); }
