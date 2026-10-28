// Headless end-to-end check of the extension against the live service (needs puppeteer-core).
// Branded Chrome 137+ ignores --load-extension, so set CHROME to Chrome for Testing.
// Usage: CHROME=... node scripts/e2e.mjs <dist dir> <audio file> [secs] [order]
//   order: before (tick Translate, then drop) | after (drop, wait for transcript, then tick) | reopen (drop, close, tick, reopen)
import puppeteer from "puppeteer-core";
const [ext, file] = [process.argv[2], process.argv[3]], secs = Number(process.argv[4] || 240), order = process.argv[5] || "before";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox"] });
let code = 1;
try {
  const swT = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
  const id = new URL(swT.url()).host;
  const open = async () => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(`chrome-extension://${id}/app.html`);
    await page.waitForSelector("#tr");
    await new Promise((r) => setTimeout(r, 300));  // settings load
    return page;
  };
  // Translate lives in the Settings view (gear); go there, toggle, come back.
  const setTick = async (page, on) => {
    if ((await page.$eval("#tr", (e) => e.checked)) === on) return;
    await page.click("#gear"); await page.click("#tr"); await page.click("#back");
  };
  const ui = (page) => page.evaluate(() => `pane ${document.querySelector("#trpane").hidden ? "hidden" : "shown"}: ${document.querySelector("#trstatus").textContent}`);
  const job = (page) => page.evaluate(async () => (await chrome.storage.session.get("job")).job ?? {});
  let page = await open();
  await setTick(page, order === "before");
  console.log("order", order, "| before drop:", await ui(page));
  await (await page.$("#file")).uploadFile(file);
  const t0 = Date.now();
  const waitFor = async (pred) => { while (Date.now() - t0 < secs * 1000) { const j = await job(page); if (pred(j)) return j; await new Promise((r) => setTimeout(r, 1000)); } return job(page); };
  let j = await waitFor((j) => j.phase === "done" || j.phase === "error");
  console.log(`transcript ${j.phase} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${j.sentences?.length} sentences, translateTo=${j.translateTo} | ${await ui(page)}`);
  if (order === "after") await setTick(page, true);
  if (order === "reopen") { await page.close(); const p2 = await open(); await setTick(p2, true); await p2.close(); page = await open(); console.log("reopened:", await ui(page)); }
  let last = "";
  j = await waitFor((j) => { const s = `${j.tr?.status} ${j.tr?.done}/${j.tr?.total}`; if (s !== last) { last = s; console.log(((Date.now() - t0) / 1000).toFixed(0) + "s tr", s); } return ["done", "error"].includes(j.tr?.status); });
  console.log("final UI:", await ui(page));
  if (process.env.SHOTS) {  // screenshots of the main and settings views at the popup's 800x600
    await page.setViewport({ width: 800, height: 600 });
    await page.evaluate(() => document.querySelector("#out").scrollTop = 0);
    await page.screenshot({ path: `${process.env.SHOTS}/main.png` });
    await page.click("#gear"); await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: `${process.env.SHOTS}/settings.png` });
    await page.click("#back");
    console.log("screenshots in", process.env.SHOTS);
  }
  console.log("FIRST:", JSON.stringify(j.sentences?.[0]?.text), "->", JSON.stringify(j.tr?.items?.[0]));
  code = j.tr?.status === "done" ? 0 : 1;
} finally { await browser.close(); }
process.exit(code);
