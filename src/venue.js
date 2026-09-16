// VIGIL — Bitget UTA v3 spot venue client (signed, demo-environment aware).
// Routes agent orders to the Bitget paper-trading venue when EXECUTION_MODE=bitget.
// Demo mode uses the PAPTRADING:1 header (Bitget's virtual-funds environment).
//
// Multi-session: createVenueClient({apiKey, secret, passphrase}) returns a fully
// bound client (per-session creds). The module-level export is the DEFAULT client
// built from env (VIGIL_BITGET_*), kept for the built-in agent + tests.
import crypto from "node:crypto";
import { UNIVERSE } from "./config.js";

export class VenueError extends Error {
  constructor(code, msg, method, path) {
    super(`bitget ${code} ${msg} (${method} ${path})`);
    this.code = code;
    this.venueMsg = msg;
  }
}

// Map VIGIL universe key -> Bitget spot symbol.
export function venueSymbol(key) {
  const u = UNIVERSE.find((x) => x.key === key);
  if (!u) return null;
  return u.crypto ? u.crypto : `R${u.bitget}USDT`;
}

export function createVenueClient({ apiKey, secret, passphrase, baseUrl } = {}) {
  const BASE = baseUrl || process.env.VIGIL_BITGET_BASE || "https://api.bitget.com";
  const KEY = apiKey ?? process.env.VIGIL_BITGET_API_KEY ?? "";
  const SECRET = secret ?? process.env.VIGIL_BITGET_SECRET ?? "";
  const PASS = passphrase ?? process.env.VIGIL_BITGET_PASSPHRASE ?? "";

  function configured() { return !!(KEY && SECRET && PASS); }

  // HMAC-SHA256 signature per Bitget v2 spec: auth = ts + METHOD + path + (POST body)
  function sign(ts, method, path, body) {
    return crypto.createHmac("sha256", SECRET).update(`${ts}${method}${path}${body}`).digest("base64");
  }

  async function call(method, path, body = null, { demo = true } = {}) {
    if (!configured()) throw new VenueError("NO_CREDS", "venue creds missing", method, path);
    const ts = Date.now().toString();
    const b = body ? JSON.stringify(body) : "";
    const headers = {
      "Content-Type": "application/json",
      "ACCESS-KEY": KEY,
      "ACCESS-SIGN": sign(ts, method, path, b),
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": PASS,
      "locale": "en-US",
    };
    if (demo) headers["PAPTRADING"] = "1";
    const res = await fetch(BASE + path, { method, headers, body: b || undefined });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { code: String(res.status), msg: text.slice(0, 200) }; }
    if (j.code !== "00000") throw new VenueError(j.code, j.msg, method, path);
    return j.data;
  }

  async function getBalances() {
    const data = await call("GET", "/api/v2/spot/account/assets");
    const out = {};
    for (const r of data || []) out[r.coin] = { available: r.available, frozen: r.frozen, locked: r.locked };
    return out;
  }

  async function usdtAvailable() {
    const b = await getBalances();
    const u = b.USDT?.available;
    return u == null ? 0 : Number(u);
  }

  async function placeMarketOrder({ key, side, size }) {
    const symbol = venueSymbol(key);
    if (!symbol) throw new VenueError("UNIVERSE", `no venue symbol for ${key}`, "POST", "/place-order");
    const data = await call("POST", "/api/v2/spot/trade/place-order", {
      symbol,
      orderType: "market",
      side,
      size,
      clientOid: `vigil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { orderId: data?.orderId, status: data?.status, symbol };
  }

  let _symCache = null;
  async function venueSymbols(force = false) {
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

  async function venueTradable(key) {
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

  async function getOrderInfo(orderId) {
    return call("GET", `/api/v2/spot/trade/orderInfo?orderId=${orderId}`);
  }

  async function waitForFill(orderId, { timeoutMs = 6000, intervalMs = 400 } = {}) {
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

  return {
    name: (!!apiKey ? apiKey.slice(0, 6) : "env"),
    configured, call, getBalances, usdtAvailable, placeMarketOrder,
    venueSymbols, venueTradable, getOrderInfo, waitForFill,
  };
}

// ---- key-type probe (multi-session Connect gate) ----
// Bitget demo keys fail on the LIVE endpoint with code 40099 ("exchange environment
// is incorrect") and only work when PAPTRADING:1 is set. A key that succeeds WITHOUT
// the PAPTRADING header is a LIVE-account key — VIGIL's Connect flow rejects those
// (demo/paper keys only; we never let a user's real account be traded from here).
export async function probeDemoKey({ apiKey, secret, passphrase, baseUrl } = {}) {
  const BASE = baseUrl || process.env.VIGIL_BITGET_BASE || "https://api.bitget.com";
  if (!(apiKey && secret && passphrase)) return { ok: false, reason: "missing apiKey/secret/passphrase" };
  const ts = Date.now().toString();
  const path = "/api/v2/spot/account/assets";
  const signature = crypto.createHmac("sha256", secret).update(`${ts}GET${path}`).digest("base64");
  const base = {
    "Content-Type": "application/json",
    "ACCESS-KEY": apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": passphrase,
    "locale": "en-US",
  };
  // 1) LIVE probe — no PAPTRADING. If this succeeds, it's a real-account key → reject.
  try {
    const res = await fetch(BASE + path, { method: "GET", headers: base, signal: AbortSignal.timeout(12_000) });
    const j = await res.json().catch(() => null);
    if (j && String(j.code) === "00000") {
      return { ok: false, live: true, reason: "LIVE-account key detected — VIGIL Connect accepts demo/paper keys only." };
    }
    if (j && String(j.code) === "40099") {
      // demo key confirmed on live endpoint
    } else {
      return { ok: false, reason: `live-probe ${j?.code || res.status}: ${j?.msg || "unexpected"}` };
    }
  } catch (e) {
    return { ok: false, reason: `live-probe network: ${e.message}` };
  }
  // 2) DEMO probe — with PAPTRADING:1; must succeed.
  try {
    const res = await fetch(BASE + path, { method: "GET", headers: { ...base, "PAPTRADING": "1" }, signal: AbortSignal.timeout(12_000) });
    const j = await res.json().catch(() => null);
    if (j && String(j.code) === "00000") {
      return { ok: true, live: false, demo: true, balances: j.data || [] };
    }
    return { ok: false, reason: `demo-probe ${j?.code || res.status}: ${j?.msg || "unexpected"}` };
  } catch (e) {
    return { ok: false, reason: `demo-probe network: ${e.message}` };
  }
}

// ---- pure helpers (no network) ----
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

export function toSizeUsd(usdMicro) {
  const n = Number(usdMicro) / 1e6;
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function toSizeBase(qtyMicro, pxMicro) {
  const px = Number(pxMicro) / 1e6;
  const qty = Number(qtyMicro) / 1e6;
  if (px <= 0) return null;
  return (qty / px).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

// ---- default (env) client — backward-compatible named exports ----
const envClient = createVenueClient();
export const venueConfigured = () => envClient.configured();
export const getBalances = () => envClient.getBalances();
export const usdtAvailable = () => envClient.usdtAvailable();
export const placeMarketOrder = (o) => envClient.placeMarketOrder(o);
export const venueSymbols = (f) => envClient.venueSymbols(f);
export const venueTradable = (k) => envClient.venueTradable(k);
export const getOrderInfo = (id) => envClient.getOrderInfo(id);
export const waitForFill = (o, t) => envClient.waitForFill(o, t);
export const defaultVenue = envClient;