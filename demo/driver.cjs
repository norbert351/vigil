// VIGIL live demo driver — captures the DEPLOYED app on :77. Writes timeline.json.
const puppeteer = require("puppeteer");
const fs = require("fs");
const CHROME = "/home/ubuntu/.cache/puppeteer/chrome/linux-152.0.7977.42/chrome-linux64/chrome";
const BASE = "https://vigil-mg0m.onrender.com";
const OUT = "/home/ubuntu/vigil/demo/timeline.json";

const shots = [
  { phase: "landing", path: "/", dwell: 6 },
  { phase: "command", path: "/app", dwell: 14 },
  { phase: "night", path: "/night", dwell: 11 },
  { phase: "leaderboard", path: "/leaderboard", dwell: 7 },
  { phase: "log", path: "/api/decision-log.csv", dwell: 7 }, // evidence tab: download header in URL bar
];
const timeline = [];
const t0 = Date.now();
async function mark(phase) { timeline.push({ t: (Date.now() - t0) / 1000, phase }); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args: [
      "--window-position=0,0", "--window-size=1280,720",
      "--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu",
      "--force-device-scale-factor=1",
    ], defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  for (const s of shots) {
    await page.goto(BASE + s.path, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => console.log("[nav]", s.path, e.message));
    await new Promise(r => setTimeout(r, 2000));
    await mark(s.phase);
    await new Promise(r => setTimeout(r, (s.dwell - 2) * 1000));
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify({ t0, timeline, voucher: Date.now() }, null, 1));
  console.log("DONE timeline:", JSON.stringify(timeline.map(x => x.phase)));
})().catch(e => { console.error("driver err", e.message); process.exit(1); });