// VIGIL — official Bitget Agent Hub US stock/ETF data layer.
// Backed by the Dev Toolkit's `bitget-mcp-server` (https://agent.bitget.com/mcp):
// stand-alone READ-ONLY data MCP for US stock/ETF quotes + history + fundamentals,
// no API key required. This is the sponsor-first source for the tokenized-US-equity
// thesis: live quotes for the rToken universe and real OHLCV history for backtests.
// Design notes:
//   - The MCP speaks JSON-RPC over HTTP and replies in Server-Sent-Events. Responses
//     with structured data carry the body in content[0].text as a secondary JSON string.
//   - A session id is issued AFTER a successful initialize (in the Mcp-Session-Id
//     response header) and must be echoed on subsequent calls.
//   - Every function is non-throwing and returns null on failure so the decision loop
//     never blocks on this layer (mirrors perception.js's resilience contract).
import { US_MCP_URL } from "./config.js";

let sessionId = null;

const MCP = { rpc: async (method, params, signalMs = 20_000) => {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), signalMs);
  try {
    const res = await fetch(US_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
      signal: ctrl.signal,
    });
    // session id is issued on the initialize response header
    if (method === "initialize") {
      const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
      if (sid) sessionId = sid;
    }
    const raw = await res.text();
    // parse the SSE `data:` lines; prefer the last complete one
    let payload = null;
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith("data:")) {
        try { payload = JSON.parse(s.slice(5).trim()); } catch { /* keep last good */ }
      }
    }
    if (!payload) { try { payload = JSON.parse(raw); } catch {} }
    return payload?.result ?? null;
  } catch { return null; } finally { clearTimeout(t); }
}, };

async function ensureSession() {
  if (sessionId) return sessionId;
  await MCP.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vigil", version: "1.0" } }, 15_000);
  return sessionId;
}

// Call a tool, return the structured body (content[0].text parse, else the raw result).
async function callTool(name, args = {}, signalMs = 20_000) {
  try {
    await ensureSession();
    const res = await MCP.rpc("tools/call", { name, arguments: args }, signalMs);
    if (res?.content && Array.isArray(res.content)) {
      for (const c of res.content) {
        if (c.type === "text" && c.text) {
          try { return JSON.parse(c.text); } catch { return c.text; }
        }
      }
    }
    return res ?? null;
  } catch { return null; }
}

// Live quote for a US symbol (e.g. "TSLA"). Returns a normalized micro-USD price object
// mirroring market.js's shape so the rest of the code can treat it uniformly.
export async function usQuote(symbol, { signalMs } = {}) {
  if (!symbol) return null;
  const q = await callTool("do_query", { entry_id: "equity_price_quote", params: { symbol } }, signalMs);
  const r = q?.data?.results?.[0];
  if (!r || r.last_price == null) return null;
  const micro = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n) * 1e6) : null);
  return {
    symbol,
    source: "bitget-mcp-server",
    lastMicro: micro(r.last_price),
    bidMicro: micro(r.bid),
    askMicro: micro(r.ask),
    chg24: Number(r.change_percent ?? 0) / 100, // MCP reports % (0.49 = 0.49%→ 0.0049)
    openMicro: micro(r.open), highMicro: micro(r.high), lowMicro: micro(r.low),
    prevCloseMicro: micro(r.prev_close),
    volume: Number(r.volume ?? 0),
    ts: r.time || Date.now(),
    asOf: r.last_timestamp || null,
  };
}

// OHLCV history for a US symbol between two dates (YYYY-MM-DD) — used by the backtest.
export async function usHistory(symbol, startDate, endDate, { signalMs } = {}) {
  if (!symbol) return [];
  const q = await callTool("do_query", {
    entry_id: "equity_price_historical",
    params: { symbol, start_date: startDate, end_date: endDate },
  }, signalMs || 30_000);
  const rows = q?.data?.results;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    date: r.date || new Date(r.time || 0).toISOString().slice(0, 10),
    ts: Number(r.time || 0),
    open: Number(r.open), high: Number(r.high), low: Number(r.low),
    close: Number(r.close), volume: Number(r.volume ?? 0),
  }));
}

// Resolve a VIGIL universe key ("rtsla", "rnvda", …) to its US ticker via the symbol map.
// Falls back to the uppercased bitget asset, or a direct guess. Non-throwing.
export function usTickerFor(key) {
  if (!key) return null;
  const m = key.match(/^r([a-z]+)$/i);
  // rtsla → TSLA, rQQQ → QQQ, raapl → AAPL; non-r keys (btc/eth) are not US equities
  return m ? m[1].toUpperCase() : null;
}

// Batch live quotes for a set of universe keys → { key: normalizedQuote }.
export async function usQuotesFor(universeKeys, { signalMs } = {}) {
  const out = {};
  await Promise.all(universeKeys.map(async (k) => {
    const sym = usTickerFor(k);
    if (!sym) return;
    const q = await usQuote(sym, { signalMs: signalMs || 12_000 });
    if (q) out[k] = q;
  }));
  return out;
}