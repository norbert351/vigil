// VIGIL — HTTP server (zero-dep node:http). Serves a live dashboard + REST + SSE
// agent stream + the paper-trading log export (for the Agentic Trading submission).
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDB, getPositions, getAgentState, listDecisions, decisionLogCsv, saveSnapshot } from "./db.js";
import { refreshPrices } from "./market.js";
import { portfolioState } from "./engine.js";
import { runSweep, agentBus, currentWindow } from "./agent.js";
import { startPerceptionLoop } from "./perception.js";
import { EXECUTION_MODE, LLM_MODE, SEED_USD_MICRO, DEFAULT_TARGETS, UNIVERSE } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8080);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".csv": "text/csv", ".json": "application/json", ".ico": "image/x-icon" };

const db = openDB();

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function usd(micro) { const n = Number(BigInt(micro)); return n / 1e6; }

async function viewModel() {
  const prices = await refreshPrices();
  const pos = getPositions(db);
  const st = portfolioState(pos, prices);
  const nav = usd(st.total);
  const seed = usd(SEED_USD_MICRO);
  const drawdown = seed > 0 ? Math.max(0, (seed - nav) / seed) : 0;
  const ag = getAgentState(db);
  const w = currentWindow();
  const holdings = Object.entries(st.detail).map(([k, d]) => ({
    key: k, name: d.name ?? k, qty: d.qty.toString(), priceUsd: d.priceUsd, valueUsd: d.valueUsd, chg24: d.chg24,
    weight: nav > 0 ? d.valueUsd / nav : 0, priced: d.priced,
  }));
  return {
    nav, seed, cash: 0, drawdown,
    window: w.window, hour: w.hour,
    executionMode: EXECUTION_MODE, llm: LLM_MODE,
    agent: { status: ag.status, nonce: ag.nonce, lastRun: ag.last_run_ts, breakerTripped: ag.breaker_tripped },
    holdings,
    targets: Object.fromEntries(Object.entries(DEFAULT_TARGETS).map(([k, v]) => [k, usd(BigInt(v))])),
    decisions: listDecisions(db, 30),
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  if (m === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }

  if (m === "GET" && p === "/health") return json(res, 200, { ok: true, name: "vigil", execution: EXECUTION_MODE, llm: LLM_MODE, deadline: "2026-09-21T00:00:00+08:00", track: "Agentic Trading", subtheme: "Cross-Asset Execution Agent" });

  if (m === "GET" && p === "/api/universe") return json(res, 200, { universe: UNIVERSE });

  if (m === "GET" && p === "/api/state") return json(res, 200, await viewModel());

  if (m === "GET" && p === "/api/prices") {
    const px = await refreshPrices(true);
    return json(res, 200, { prices: Object.fromEntries(Object.entries(px).map(([k, v]) => [k, v.lastMicro != null ? { usd: v.lastMicro / 1e6, micro: v.lastMicro, chg24: v.chg24, asset: v.asset } : { error: v.error }])) });
  }

  if (m === "GET" && p === "/api/decisions") return json(res, 200, { decisions: listDecisions(db, 200) });

  if (m === "GET" && p === "/api/decision-log.csv") {
    const rows = decisionLogCsv(db, 0);
    const hdr = "seq,ts,window,trigger,llm,nav_micro,rationale,orders";
    const lines = [hdr];
    for (const r of rows) {
      const esc = (s) => `"${String(s ?? "").replace(/"/g, "'")}"`;
      lines.push([r.seq, r.ts, r.window, r.trigger, r.llm, r.nav_micro, esc(r.rationale), esc(r.orders)].join(","));
    }
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="vigil-decision-log.csv"' });
    return res.end(lines.join("\n"));
  }

  if (m === "POST" && p === "/api/run") {
    try { const r = await runSweep(db, { force: true }); return json(res, 200, r); }
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  if (m === "GET" && p === "/api/agent/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    const onEvent = (e) => { try { res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`); } catch {} };
    agentBus.on("event", onEvent);
    const hb = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15_000);
    req.on("close", () => { agentBus.off("event", onEvent); clearInterval(hb); });
    return;
  }

  // static
  if (m === "GET" || m === "HEAD") {
    let file = path.normalize(url.pathname);
    if (file === "/" || file === "") file = "/dashboard.html";
    if (file.includes("..")) return json(res, 403, { error: "forbidden" });
    const abs = path.join(PUBLIC_DIR, file);
    if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs) || !statSync(abs).isFile()) return json(res, 404, { error: "not found" });
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    if (m === "HEAD") return res.end();
    return res.end(readFileSync(abs));
  }
  return json(res, 404, { error: "not found", p });
}

const server = http.createServer((req, res) => route(req, res).catch((e) => {
  console.error("[route]", req.method, req.url, String(e?.stack || e));
  if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
}));

server.listen(PORT, () => {
  console.log(`VIGIL listening on :${PORT} (exec=${EXECUTION_MODE}, llm=${LLM_MODE})`);
  startPerceptionLoop();      // background overnight context (MCP + fallbacks)
  // warm a first sweep so the dashboard has data
  runSweep(db).then((r) => console.log("warm sweep:", JSON.stringify(r).slice(0, 200))).catch((e) => console.error("warm", e.message));
});

// autonomous scheduler
const SCAN = Number(process.env.VIGIL_SCAN_MS || 300_000);
const sched = setInterval(async () => { try { await runSweep(db); } catch (e) { console.error("sweep", e.message); } }, SCAN);
sched.unref?.();

export { server, db };