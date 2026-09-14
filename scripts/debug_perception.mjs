import { ensureSession, callTool } from "../src/perception.js";
for (const [name, args] of [
  ["sentiment_index", {}],
  ["news_feed", { action: "latest", feeds: "cointelegraph,coindesk", limit: 2 }],
  ["macro_indicators", { action: "latest_release", indicator: "cpi" }],
  ["tradfi_news", { action: "earnings", from_date: "2026-09-14", to_date: "2026-09-17" }],
]) {
  try {
    const r = await callTool(name, args);
    console.log("==== ", name, "====");
    console.log(JSON.stringify(r).slice(0, 600));
  } catch (e) { console.log(name, "ERR", e.message); }
}
