// VIGIL — Bitget UTA v3 spot venue client (signed, demo-environment aware).
// Routes agent orders to the Bitget paper-trading venue when EXECUTION_MODE=bitget.
// Demo mode uses the PAPTRADING:1 header (Bitget's virtual-funds environment).
import crypto from "node:crypto";
import { UNIVERSE } from "./config.js";

const BASE = process.env.VIGIL_BITGET_BASE || "https://api.bitget.com";
const KEY = process.env.VIGIL_BITGET_API_KEY || "";
const SECRET = process.env.VIGIL_BITGET_SECRET || "";
const PASS = process.env.VIGIL_BITGET_PASSPHRASE || "";

export function venueConfigured() {
  return !!(KEY && SECRET && PASS);
}

// HMAC-SHA256 signature per Bitget v2 spec:
//   auth = timestamp + METHOD + requestPath + (POST body)
function sign(ts, method, path, body) {
  return crypto.createHmac("sha256", SECRET).update(`${ts}${method}${path}${body}`).digest("base64");
}

async function call(method, path, body = null) {
  const ts = Date.now().toString();
  const b = body ? JSON.stringify(body) : "";
  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": KEY,
    "ACCESS-SIGN": sign(ts, method, path, b),
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": PASS,
    "PAPTRADING": "1", // demo / virtual-funds environment
    "locale": "en-US",
  };
  const res = await fetch(BASE + path, { method, headers, body: b || undefined });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { code: String(res.status), msg: text.slice(0, 200) }; }
  if (j.code !== "00000") throw new VenueError(j.code, j.msg, method, path);
  return j.data;
}

export class VenueError extends Error {
  constructor(code, msg, method, path) {
    super(`bitget ${code} ${msg} (${method} ${path})`);
    this.code = code;
    this.venueMsg = msg;
  }
}

// Map VIGIL universe key -> Bitget spot symbol.
//   crypto keys (btc/eth) -> BTCUSDT / ETHUSDT
//   equity keys (rtsla..) -> R<SYMBOL>USDT (tokenized stock)
export function venueSymbol(key) {
  const u = UNIVERSE.find((x) => x.key === key);
  if (!u) return null;
  return u.crypto ? u.crypto : `R${u.bitget}USDT`;
}

// ---- read side (never moves money) ----

// All spot balances: { coin: { available, frozen, locked } }
export async function getBalances() {
  const data = await call("GET", "/api/v2/spot/account/assets");
  const out = {};
  for (const r of data || []) out[r.coin] = { available: r.available, frozen: r.frozen, locked: r.locked };
  return out;
}

// USD available in the spot wallet (the buy-side constraint).
export async function usdtAvailable() {
  const b = await getBalances();
  const u = b.USDT?.available;
  return u == null ? 0 : Number(u);
}

// ---- write side (only reached when EXECUTION_MODE=bitget) ----

// Market order. side: 'buy'|'sell'. size is a DECIMAL STRING:
//   buy  -> quote amount (USDT) the market order spends
//   sell -> base amount (coin units) the market order sells
// Returns { orderId, status } (market orders fill instantly or are rejected).
export async function placeMarketOrder({ key, side, size }) {
  const symbol = venueSymbol(key);
  if (!symbol) throw new VenueError("UNIVERSE", `no venue symbol for ${key}`);
  const data = await call("POST", "/api/v2/spot/trade/place-order", {
    symbol,
    orderType: "market",
    side,
    size,
    clientOid: `vigil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { orderId: data?.orderId, status: data?.status, symbol };
}

// ---- venue capability map ----
// The demo environment publishes its OWN tradable symbol list (25 symbols) when the
// PAPTRADING header is sent. Tokenized stocks (rToken) are listed but `status:"halt"`
// and region-restricted there, so they cannot be venue-traded — VIGIL detects this and
// routes those legs to a clearly-labelled paper fill instead of failing blind.
let _symCache = null;

export async function venueSymbols(force = false) {
  if (!force && _symCache && Date.now() - _symCache.at < 300_000) return _symCache.map;
  const data = await call("GET", "/api/v2/spot/public/symbols");
  const map = {};
  for (const s of data || []) {
    map[s.symbol] = {
      status: s.status,
      quantityPrecision: Number(s.quantityPrecision ?? 4),
      quotePrecision: Number(s.quotePrecision ?? 6),
      minTradeUSDT: Number(s.minTradeUSDT || 0),
      areaSymbol: s.areaSymbol,
    };
  }
  _symCache = { at: Date.now(), map };
  return map;
}

// Can this universe key be traded on the venue right now?
export async function venueTradable(key) {
  const sym = venueSymbol(key);
  if (!sym) return { ok: false, reason: "no venue symbol" };
  try {
    const m = await venueSymbols();
    const e = m[sym];
    if (!e) return { ok: false, reason: `${sym} not in demo venue list` };
    if (e.status !== "online") return { ok: false, reason: `${sym} status=${e.status}` };
    if (e.areaSymbol === "yes") return { ok: false, reason: `${sym} region-restricted` };
    return { ok: true, meta: e, symbol: sym };
  } catch (err) {
    return { ok: false, reason: `symbol list unavailable: ${err.message}`, unknown: true };
  }
}

// Truncate a decimal string to N decimals (floor) — never overshoot the venue's
// quantity precision, which would be rejected with "Parameter verification exception".
export function floorTo(value, precision) {
  const f = 10 ** precision;
  const v = Math.floor(Number(value) * f) / f;
  return v.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");
}

export function roundTo(value, precision) {
  const f = 10 ** precision;
  const v = Math.round(Number(value) * f) / f;
  return v.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");
}

// Fill details for a placed order (price, filled base qty, fee).
export async function getOrderInfo(orderId) {
  const data = await call("GET", `/api/v2/spot/trade/orderInfo?orderId=${orderId}`);
  return data;
}

// Market orders settle asynchronously — poll orderInfo until filled (or timeout).
// Without this the immediate query returns price/size 0 and the decision log loses
// the real fill economics.
export async function waitForFill(orderId, { timeoutMs = 6000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const info = (await getOrderInfo(orderId))?.[0] || null;
      last = info;
      if (info && (info.status === "filled" || info.status === "partial_fill")) return info;
      if (info && (info.status === "canceled" || info.status === "cancelled")) return info;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

export function toSizeUsd(usdMicro) {
  // micro-USD (1e6 = $1) -> decimal USDT string (market buy spends this much quote)
  const n = Number(usdMicro) / 1e6;
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function toSizeBase(qtyMicro, pxMicro) {
  // micro-units (1e6 = 1 token) -> decimal base string (market sell)
  const px = Number(pxMicro) / 1e6;
  const qty = Number(qtyMicro) / 1e6;
  if (px <= 0) return null;
  return (qty / px).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}