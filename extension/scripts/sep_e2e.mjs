import puppeteer from "puppeteer-core";
const [ext, file, tick] = [process.argv[2], process.argv[3], process.argv[4] === "on"];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox"] });
const sw = await browser.waitForTarget((t) => t.type() === "service_worker");
const id = new URL(sw.url()).host;
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`chrome-extension://${id}/app.html`); await page.waitForSelector("#sep");
console.log("default Remove vocals:", await page.$eval("#sep", (e) => e.checked));
await page.click("#gear"); await page.$eval("#server", (e) => { e.value = "http://192.168.8.226:18998"; e.dispatchEvent(new Event("change")); });
if (tick) await page.click("#sep");
await page.click("#back"); await new Promise((r) => setTimeout(r, 300));
await (await page.$("#file")).uploadFile(file);
const ui = () => page.evaluate(() => ({ bar: !document.querySelector("#sepbar").hidden, st: document.querySelector("#sepstatus").textContent,
  dl: document.querySelector("#sepdl").hidden ? null : document.querySelector("#sepdl").href, mode: document.querySelector("#sepmode").hidden ? null : document.querySelector("#sepmode").textContent,
  h: document.body.offsetHeight, w: document.body.offsetWidth }));
for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 1000)); console.log(JSON.stringify(await ui())); }
if (tick) {
  await page.click("#sepmode"); await new Promise((r) => setTimeout(r, 800));
  console.log("after toggle:", JSON.stringify(await ui()), "src", await page.evaluate(() => document.querySelector("#player").src), "words", await page.$$eval("#out .w", (e) => e.length));
}
await page.click("#clear"); await new Promise((r) => setTimeout(r, 800));
console.log("after clear:", JSON.stringify(await ui()), JSON.stringify(await page.evaluate(async () => (await chrome.storage.session.get("job")).job)));
await browser.close();
