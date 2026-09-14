// VIGIL — live cross-asset macro regime. Derived entirely from data the agent already
// fetches reliably (Bitget prices + Fear & Greed), so it is always live and verifiable —
// unlike fragile external VIX/DXY feeds. This is the "macro context" handed to the
// decision-maker and bound into each signed manifest.
export function breadth(prices) {
  let up = 0, n = 0;
  for (const p of Object.values(prices)) {
    if (p && p.lastMicro != null && p.chg24 != null) { n++; if (p.chg24 > 0) up++; }
  }
  return n ? up / n : null;
}

// Cross-asset regime from live price action + Fear & Greed.
export function crossAssetRegime(prices, fearGreed) {
  const g = (k) => (prices[k] && prices[k].chg24 != null ? prices[k].chg24 : null);
  const btc = g("btc"), eth = g("eth");
  const cryptoNames = ["btc", "eth"].map(g).filter((x) => x != null);
  // rToken equity breadth (everything not crypto)
  const equity = [];
  for (const k of Object.keys(prices)) {
    if (prices[k]?.lastMicro != null && prices[k]?.chg24 != null) {
      if (k !== "btc" && k !== "eth" && prices[k].asset !== "crypto") equity.push(prices[k].chg24);
    }
  }
  const cryptoAvg = cryptoNames.length ? cryptoNames.reduce((a, b) => a + b, 0) / cryptoNames.length : null;
  const equityAvg = equity.length ? equity.reduce((a, b) => a + b, 0) / equity.length : null;
  const br = breadth(prices);
  const fng = fearGreed != null ? Number(fearGreed) : null;

  let score = 0;
  if (btc != null) score += clamp(btc * 6, -2, 2);            // BTC 24h momentum
  if (cryptoAvg != null) score += clamp(cryptoAvg * 4, -1.5, 1.5);
  if (equityAvg != null) score += clamp(equityAvg * 4, -1.5, 1.5);
  if (br != null) score += clamp((br - 0.5) * 4, -1, 1);      // breadth
  if (fng != null) score += clamp((fng - 50) / 30, -1, 1);     // sentiment

  let regime;
  if (score <= -1.5 || (fng != null && fng < 35)) regime = "risk-off";
  else if (score >= 1.5 || (fng != null && fng > 70)) regime = "risk-on";
  else regime = "neutral";

  // bump risk-off overnight (the "hours humans sleep" posture) is handled in the risk layer.
  return {
    regime, score: round1(score), fng,
    btc24h: pct(btc), cryptoAvg24h: pct(cryptoAvg), equityAvg24h: pct(equityAvg), breadth: br != null ? round2(br) : null,
    note: `${regime} · btc ${pct(btc)} · rToken ${pct(equityAvg)} · breadth ${br != null ? round2(br) : "—"}`,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function pct(v) { return v == null ? "—" : `${Math.round(v * 100)}%`; }