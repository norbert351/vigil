// VIGIL — read-only Bitget UTA v3 probe.
// Proves the credential set works WITHOUT touching money: signs a GET assets
// request and prints the raw response. Never submits an order.
import crypto from "node:crypto";

const KEY = process.env.VIGIL_BITGET_API_KEY;
const SECRET = process.env.VIGIL_BITGET_SECRET;
const PASS = process.env.VIGIL_BITGET_PASSPHRASE;

const BASE = process.env.VIGIL_BITGET_BASE || "https://api.bitget.com";

function sign(timestamp, method, path, body) {
  const str = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", SECRET).update(str).digest("base64");
}

async function call(method, path) {
  const ts = Date.now().toString();
  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": KEY,
    "ACCESS-SIGN": sign(ts, method, path, ""),
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": PASS,
    "locale": "en-US",
  };
  const url = BASE + path;
  const res = await fetch(url, { method, headers });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 800) };
}

// Read-only endpoints — no orders, no funds moved.
const probes = [
  ["GET", "/api/v2/spot/account/assets"],
  ["GET", "/api/v2/spot/account/bills?coin=USDT&limit=1"],
  ["GET", "/api/v2/spot/trade/order-history?limit=1"],
];

for (const [m, p] of probes) {
  try {
    const r = await call(m, p);
    console.log(`\n=== ${m} ${p} ===\nHTTP ${r.status}\n${r.body}`);
  } catch (e) {
    console.log(`\n=== ${m} ${p} ===\nERROR ${e.message}`);
  }
}