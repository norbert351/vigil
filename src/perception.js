// VIGIL — perception layer. The agent's overnight "eyes".
// Primary: Bitget's market-data MCP (datahub.noxiaohao.com/mcp, the backend behind
// bitget-signal) — sponsor-first. Because that server is slow from some hosts, every
// heavy tool has a fast public fallback (Crypto Fear & Greed via alternative.me) and
// the whole perception set is refreshed IN THE BACKGROUND and cached, so the decision
// loop never blocks on it. Failures are non-fatal.
import { DATDHUB_MCP_URL } from "./config.js";

let sessionId = null;

async function rpc(method, params, timeoutMs = 18_000) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(DATDHUB_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let payload = null;
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (s.startsWith("data:")) {
        const body = s.slice(5).trim();
        try { payload = JSON.parse(body); break; } catch {}
      }
    }
    if (!payload) { try { payload = JSON.parse(raw); } catch {} }
    if (method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
    }
    return payload?.result;
  } finally {
    clearTimeout(t);
  }
}

async function ensureSession() {
  if (sessionId) return sessionId;
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vigil", version: "0.1" } }, 12_000);
  return sessionId;
}

export async function callTool(name, args = {}, timeoutMs) {
  try {
    await ensureSession();
    const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (res?.content && Array.isArray(res.content)) {
      for (const c of res.content) {
        if (c.type === "text" && c.text) {
          try { return JSON.parse(c.text); } catch { return c.text; }
        }
      }
    }
    return null;
  } catch { return null; }
}

// ---- sentiment: MCP primary, alternative.me fallback (fast, reliable) ----
export async function sentimentFearGreed() {
  const r = await callTool("sentiment_index", {}, 12_000);
  if (r) {
    const d = r.data || r;
    const val = d.value ?? d.current;
    const cls = d.classification ?? d.value_classification ?? d.valueText;
    if (val != null) return { source: "bitget-mcp", value: Number(val), classification: cls };
  }
  try {
    const res = await fetch("https://api.alternative.me/fng/", { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const d = j.data?.[0];
    if (d) return { source: "alternative.me", value: Number(d.value), classification: d.value_classification, ts: d.timestamp };
  } catch {}
  return null;
}

export async function newsBriefing(limit = 6) {
  // Primary: Bitget MCP news_feed. Fallback: fast public RSS (Cointelegraph + BBC Business).
  const r = await callTool("news_feed", { action: "latest", feeds: "cointelegraph,coindesk,cnbc,fed,blockworks,decrypt", limit }, 25_000);
  const items = flattenNews(r);
  if (items.length >= 2) return items.slice(0, limit);
  const fb = await rssFallback(limit);
  return fb.length ? fb : items;
}

function flattenNews(r) {
  if (!Array.isArray(r)) return [];
  const out = [];
  for (const feed of r) {
    for (const it of (feed.items || [])) {
      if (it && (it.title)) out.push({ title: it.title, source: feed.feed, url: it.url || it.link, ts: it.published || it.ts });
    }
  }
  return out;
}

const RSS_FEEDS = [
  { source: "cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "bbc-business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
];
async function rssFallback(limit) {
  const out = [];
  for (const f of RSS_FEEDS) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 VIGIL" } });
      const xml = await res.text();
      const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)]
        .map((m) => m[1].replace(/&amp;/g, "&").trim())
        .filter((t) => t && !/^(Cointelegraph|BBC News)/i.test(t));
      for (const t of titles.slice(0, limit)) out.push({ title: t, source: f.source });
    } catch {}
  }
  return out;
}

export async function macroSnapshot() {
  const r = await callTool("macro_indicators", { action: "latest_release", indicator: "cpi" }, 15_000);
  if (r && Array.isArray(r.data) && r.data.length) return r.data[0];
  return r && String(r?.error ?? "") === "" ? r : null;
}

export async function earningsNear(fromDate, toDate) {
  const r = await callTool("tradfi_news", { action: "earnings", from_date: fromDate, to_date: toDate, limit: 10 }, 12_000);
  return r;
}

// ---- background-refreshed perception cache ----
let PERC = { at: 0, data: null, error: null };

export async function collectPerception({ limit = 5 } = {}) {
  const [fng, news, macro, earnings] = await Promise.allSettled([
    sentimentFearGreed(),
    newsBriefing(limit),
    macroSnapshot(),
    earningsNear(isoDaysAgo(0), isoDaysAhead(3)),
  ]);
  const ok = (p) => (p.status === "fulfilled" ? p.value : null);
  const data = {
    at: Date.now(),
    fearGreed: ok(fng),
    news: Array.isArray(ok(news)) ? ok(news).slice(0, limit) : null,
    macro: ok(macro),
    earnings: Array.isArray(ok(earnings)) ? ok(earnings).slice(0, limit) : null,
  };
  PERC = { at: Date.now(), data, error: null };
  return data;
}

// Non-blocking read for the decision loop (never throws, returns last good snapshot).
export function latestPerception() {
  return PERC.data;
}

const REFRESH_MS = 4 * 60_000;
let loop = null;
export function startPerceptionLoop() {
  if (loop) return loop;
  const refresh = async () => { try { await collectPerception(); } catch {} };
  refresh(); // prime immediately
  loop = setInterval(refresh, REFRESH_MS);
  loop.unref?.();
  return loop;
}

function isoDaysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }
function isoDaysAhead(n) { return new Date(Date.now() + n * 864e5).toISOString().slice(0, 10); }