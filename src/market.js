// VIGIL — Bitget public market-data layer (no API key).
// Resolves the curated universe to live Bitget symbols at boot:
//   crypto keys (btc/eth) -> BTCUSDT / ETHUSDT
//   equity keys (rtsla...) -> R<SYMBOL>USDT  (tokenized US stocks, e.g. RTSLAUSDT)
// Returns micro-USD price per unit (1e6 = $1) plus a 24h % move used by the agent.
import { BITGET_TICKERS_URL, UNIVERSE } from "./config.js";

let cache = { at: 0, prices: null, symbolMap: null };
const TTL_MS = 15_000;

// Fetch the full spot ticker feed (1760+ pairs incl. 1199 rTokens).
async function fetchTickers() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(BITGET_TICKERS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`bitget tickers http ${res.status}`);
    const j = await res.json();
    if (j.code !== "00000") throw new Error(`bitget tickers code ${j.code}`);
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

function parsePrice(s) {
  // string -> micro-usd per unit (1e6 = $1). Bitget prices are decimal strings.
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e6);
}

export async function refreshPrices(force = false) {
  if (!force && cache.prices && Date.now() - cache.at < TTL_MS) return cache.prices;
  const rows = await fetchTickers();
  // Build symbol -> {lastMicro, chg24, bidMicro, askMicro}
  const bySym = {};
  for (const r of rows) {
    const sym = r.symbol;
    const last = parsePrice(r.lastPr ?? r.closePrice);
    if (last == null) continue;
    bySym[sym] = {
      lastMicro: last,
      chg24: Number(r.change24h ?? 0),
      bidMicro: parsePrice(r.bestBidPr),
      askMicro: parsePrice(r.bestAskPr),
      updatedAt: Date.now(),
    };
  }
  // Resolve universe: crypto keys are their raw pair; equity keys are R<SYMBOL>USDT.
  const symbolMap = {};
  const prices = {};
  for (const u of UNIVERSE) {
    const sym = u.crypto ? u.crypto : `R${u.bitget}USDT`;
    symbolMap[u.key] = sym;
    const t = bySym[sym];
    if (t) prices[u.key] = { ...t, symbol: sym, name: u.name, asset: u.asset };
    else {
      // symbol not in feed yet — mark unhealthy (may be a sparse/de-listed rToken)
      prices[u.key] = { error: `no ticker ${sym}`, symbol: sym, name: u.name, asset: u.asset, lastMicro: null };
    }
  }
  cache = { at: Date.now(), prices, symbolMap };
  return cache.prices;
}

// Convenience: latest prices, non-throwing.
export async function getPrices() {
  try {
    return await refreshPrices();
  } catch (e) {
    if (cache.prices) return cache.prices;
    throw e;
  }
}

export function symbolMap() {
  return cache.symbolMap || {};
}

// A single asset's live price as { micro, usd, chg24 }.
export function normalize(px) {
  if (!px || px.lastMicro == null) return null;
  return {
    micro: BigInt(px.lastMicro),
    usd: Number(px.lastMicro) / 1e6,
    chg24: px.chg24 ?? 0,
    bidMicro: px.bidMicro != null ? BigInt(px.bidMicro) : null,
    askMicro: px.askMicro != null ? BigInt(px.askMicro) : null,
  };
}