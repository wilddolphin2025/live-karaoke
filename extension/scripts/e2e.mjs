// Headless end-to-end check (needs puppeteer-core; branded Chrome 137+ ignores --load-extension, so set CHROME to Chrome for Testing).
// Usage: CHROME=... node scripts/e2e.mjs <dist dir> <audio file> [secs]
import puppeteer from "puppeteer-core";
const ext = process.argv[2], file = process.argv[3], secs = Number(process.argv[4] || 240);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox"] });
const swT = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
const id = new URL(swT.url()).host;
const sw = await swT.worker();
sw.on("console", (m) => console.log("[sw]", m.text()));
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`chrome-extension://${id}/app.html`);
await page.waitForSelector("#tr");
await page.click("#tr");
console.log("checked:", await page.$eval("#tr", (e) => e.checked), "server:", await page.$eval("#server", (e) => e.value));
const input = await page.$("#file");
await input.uploadFile(file);
const t0 = Date.now(); let last = "";
while (Date.now() - t0 < secs * 1000) {
  const job = await page.evaluate(async () => (await chrome.storage.session.get("job")).job);
  const s = JSON.stringify({ phase: job?.phase, n: job?.sentences?.length, tr: job?.tr && { ...job.tr, items: job.tr.items.filter((x) => x != null).length }, err: job?.error });
  if (s !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1), s, "| ui:", await page.$eval("#trstatus", (e) => e.textContent)); last = s; }
  if (job?.tr?.status === "done" || job?.tr?.status === "error" || job?.phase === "error") break;
  await new Promise((r) => setTimeout(r, 1000));
}
const job = await page.evaluate(async () => (await chrome.storage.session.get("job")).job);
console.log("FIRST:", JSON.stringify(job?.sentences?.slice(0, 2)), JSON.stringify(job?.tr?.items?.slice(0, 2)));
await browser.close();
