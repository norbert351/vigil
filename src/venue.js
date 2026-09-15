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

// Fill details for a placed order (price, filled base qty, fee).
export async function getOrderInfo(orderId) {
  const data = await call("GET", `/api/v2/spot/trade/orderInfo?orderId=${orderId}`);
  return data;
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