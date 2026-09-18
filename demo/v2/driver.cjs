// VIGIL cinematic live demo driver — walks the DEPLOYED app on :77, writes timeline.json.
const puppeteer = require("puppeteer");
const fs = require("fs");
const CHROME = "/home/ubuntu/.cache/puppeteer/chrome/linux-152.0.7977.42/chrome-linux64/chrome";
const BASE = "https://vigil-mg0m.onrender.com";
const OUT = "/home/ubuntu/vigil/demo/v2/timeline.json";

const shots = [
  { phase: "landing",  path: "/",             dwell: 6 },
  { phase: "connect",  path: "/connect",      dwell: 8 },
  { phase: "command",  path: "/app",          dwell: 15 },
  { phase: "night",    path: "/night",        dwell: 11 },
  { phase: "leader",   path: "/leaderboard",  dwell: 6 },
  { phase: "report",   path: "/reports/latest", dwell: 12 },
];
const timeline = [];
const t0 = Date.now();
async function mark(phase) { timeline.push({ t: (Date.now() - t0) / 1000, phase }); }
async function scroll(page, phase) {
  try {
    // slow scroll to reveal the page's content as a live action, not a static frame
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 300)); await new Promise(r => setTimeout(r, 550)); }
    await page.evaluate(() => window.scrollTo(0, 0)); await new Promise(r => setTimeout(r, 700));
  } catch {}
  await mark(phase);
  // dwell held by caller around scroll
}
(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args: [
      "--window-position=0,0", "--window-size=1280,720", "--disable-dev-shm-usage",
      "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1",
    ], defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const NAV = async (p) => { await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => console.log("[nav]", p, e.message)); await new Promise(r => setTimeout(r, 2200)); };
  const SW = shots[0]; await NAV(SW.path); await scroll(page, SW.phase); await new Promise(r => setTimeout(r, (SW.dwell - 4) * 1000));
  for (const s of shots.slice(1)) {
    await NAV(s.path);
    await scroll(page, s.phase);
    await new Promise(r => setTimeout(r, (s.dwell - 4) * 1000));
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify({ t0, timeline, voucher: Date.now() }, null, 1));
  console.log("DONE", JSON.stringify(timeline.map(x => x.phase)));
})().catch(e => { console.error("driver err", e.message); process.exit(1); });