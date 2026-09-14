import { sentimentFearGreed, newsBriefing, macroSnapshot, earningsNear, collectPerception } from "../src/perception.js";
try {
  const p = await collectPerception({ limit: 3 });
  console.log("fearGreed:", JSON.stringify(p.fearGreed));
  console.log("news count:", Array.isArray(p.news)? p.news.length : (p.news?1:0), JSON.stringify(p.news).slice(0,300));
  console.log("macro:", JSON.stringify(p.macro).slice(0,200));
  console.log("earnings count:", Array.isArray(p.earnings)? p.earnings.length : (p.earnings?1:0));
} catch (e) { console.error("PERCEPTION FAIL:", e.message); }
