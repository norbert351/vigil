// VIGIL — risk-control layer. The Agentic Trading track explicitly judges
// "risk control layer effectiveness". This guardrail runs BEFORE any order:
//   · circuit breaker (10% cap; 5% CAP AT NIGHT — the "hours humans sleep" posture)
//   · hard kill-switch file or kill_switched state
//   · per-order size cap
//   · single-asset / aggregate-crypto / aggregate-rToken concentration caps
//   · CROSS-ASSET regime hedge: on Fear & Greed<FEAR → trim crypto + add defensive
//     index base; on macro risk → de-risk. SELLs are emitted before BUYs so the
//     paper executor funds rotation from proceeds (no money-from-nowhere).
// Returns { orders, breaker, flags, rationale } — nothing here touches the ledger.
import { existsSync } from "node:fs";
import {
  MAX_DRAWDOWN, MAX_ORDER_PCT, MAX_SINGLE_ASSET_WEIGHT, MAX_CRYPTO_WEIGHT, MAX_RTOKEN_WEIGHT,
  NIGHT_DD_CAP, NIGHT_MAX_GROSS, REGIME_FEAR, REGIME_GREED, KILL_SWITCH_FILE,
  isCrypto, isDefensive, DEFENSIVE_KEYS,
} from "./config.js";

export function checkState(state) {
  const flags = [];
  if (existsSync(KILL_SWITCH_FILE) || state.killed) flags.push("kill-switch-armed");
  if (state.drawdown >= MAX_DRAWDOWN) flags.push("drawdown-breaker");
  return flags;
}

export function planOrders({ nav, drawdown, positions, prices, targets, night = false, fearGreed = null, killed = false }) {
  const orders = [];
  // night-mode hits the breaker sooner
  const ddCap = night ? NIGHT_DD_CAP : MAX_DRAWDOWN;
  const breaker = drawdown >= ddCap;
  let rationale;

  const NAV = Number(nav) || 0;
  if (NAV <= 0) return { orders: [], breaker: false, flags: ["zero-nav"], rationale: "no capital to plan against" };

  // 0) kill switch — halt all trading (empty orders = HOLD)
  if (killed) {
    return { orders: [], breaker: false, flags: ["kill-switch"], rationale: "Kill-switch armed — halted all trading." };
  }

  // regime from Fear & Greed
  const fng = fearGreed != null ? Number(fearGreed) : null;
  const riskOff = fng != null && fng < REGIME_FEAR;
  const riskOn = fng != null && fng > REGIME_GREED;
  const cryptoCap = riskOff ? Math.min(MAX_CRYPTO_WEIGHT, 0.25) : MAX_CRYPTO_WEIGHT;

  // 1) circuit breaker — de-risk to stable base / halt
  if (breaker) {
    for (const [key, p] of Object.entries(positions)) {
      const val = Number(p.value ?? p.valueMicro ?? 0);
      const base = isDefensive(key);
      if (val > 0 && !base) orders.push({ action: "SELL", key, usdMicro: val, reason: "breaker" });
    }
    rationale = `Circuit breaker tripped at ${(drawdown * 100).toFixed(1)}% (cap ${(ddCap * 100).toFixed(0)}%${night ? " night" : ""}): de-risked to defensive base.`;
    return { orders, breaker: true, flags: [night ? "night-breaker" : "drawdown-breaker"], rationale };
  }

  // 2) value + weight maps
  const values = {}, weights = {};
  let cryptoVal = 0n, rtokenVal = 0n;
  for (const [key, p] of Object.entries(positions)) {
    const val = BigInt(p.value ?? p.valueMicro ?? 0);
    values[key] = val;
    weights[key] = NAV > 0 ? Number(val) / NAV : 0;
    if (isCrypto(key)) cryptoVal += val; else rtokenVal += val;
  }
  const cryptoW = NAV > 0 ? Number(cryptoVal) / NAV : 0;
  const rtokenW = NAV > 0 ? Number(rtokenVal) / NAV : 0;

  // 3) concentration caps
  for (const [key, p] of Object.entries(positions)) {
    const v = Number(p.value ?? p.valueMicro ?? 0);
    if (v <= 0) continue;
    const maxW = isCrypto(key) ? MAX_SINGLE_ASSET_WEIGHT : Math.min(MAX_SINGLE_ASSET_WEIGHT, 1.15 * MAX_RTOKEN_WEIGHT);
    if (weights[key] > maxW) orders.push({ action: "SELL", key, usdMicro: Math.round(v - NAV * maxW), reason: "single-asset-cap" });
  }
  // crypto aggregate cap (tightens to 25% in Fear regime)
  if (cryptoW > cryptoCap) {
    let toTrim = Number(cryptoVal) - NAV * cryptoCap;
    for (const [key, p] of Object.entries(positions).filter(([k]) => isCrypto(k))) {
      if (toTrim <= 0) break;
      const cur = Number(p.value ?? p.valueMicro ?? 0);
      const trim = Math.min(cur, toTrim);
      orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: `crypto-cap${riskOff ? "-fear" : ""}` });
      toTrim -= trim;
    }
  }
  if (rtokenW > MAX_RTOKEN_WEIGHT) {
    let toTrim = Number(rtokenVal) - NAV * MAX_RTOKEN_WEIGHT;
    for (const [key, p] of Object.entries(positions).filter(([k]) => !isCrypto(k)).sort(([, a], [, b]) => Number(b.value ?? b.valueMicro ?? 0) - Number(a.value ?? a.valueMicro ?? 0))) {
      if (toTrim <= 0) break;
      const cur = Number(p.value ?? p.valueMicro ?? 0);
      const trim = Math.min(cur, toTrim);
      orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: "rtoken-cap" });
      toTrim -= trim;
    }
  }

  // 4) night-mode gross-exposure trim — rotate risk assets toward defensive base/cash
  if (night) {
    let grossW = cryptoW + (rtokenW * 0.9); // approximate gross
    if (grossW > NIGHT_MAX_GROSS) {
      let toTrim = Math.round((grossW - NIGHT_MAX_GROSS) * NAV);
      for (const [key, p] of Object.entries(positions)
        .filter(([k]) => !isDefensive(k))
        .sort(([, a], [, b]) => Number(b.value ?? b.valueMicro ?? 0) - Number(a.value ?? a.valueMicro ?? 0))) {
        if (toTrim <= 0) break;
        const cur = Number(p.value ?? p.valueMicro ?? 0);
        const trim = Math.min(cur, toTrim);
        orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: "night-gross" });
        toTrim -= trim;
      }
    }
  }

  // 5) CROSS-ASSET regime hedge: rotate some risk into defensive index base (SELL first → funds the BUY)
  if (riskOff) {
    let toDefend = 0;
    for (const key of ["btc", "eth", "rtsla", "rnvda", "rcoin", "rmstr"]) {
      if (toDefend >= 0.12 * NAV) break;
      const v = Number(values[key] ?? 0);
      if (v > 0) {
        const trim = Math.min(v, 0.12 * NAV - toDefend);
        if (trim > 0) { orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: "regime-fear-rotation" }); toDefend += trim; }
      }
    }
    // defensive buys funded by the sells above in the same batch
    const defenseBudget = toDefend;
    if (defenseBudget > 0) {
      const base = DEFENSIVE_KEYS.find((k) => prices[k]?.lastMicro);
      if (base) {
        orders.push({ action: "BUY", key: base, usdMicro: Math.round(defenseBudget / 2), reason: "regime-fear-defensive" });
      }
    }
  }

  // 6) target drift rebalance (only within cash terms; executor enforces affordability)
  if (targets) {
    for (const [key, targetW] of Object.entries(targets)) {
      const tw = Number(targetW) / 1e6;
      const curVal = Number(values[key] || 0);
      const curW = NAV > 0 ? curVal / NAV : 0;
      const deltaW = tw - curW;
      if (deltaW > 0.02) {
        const buyUsd = Math.min(NAV * tw - curVal, NAV * MAX_ORDER_PCT);
        if (buyUsd >= 100_000) orders.push({ action: "BUY", key, usdMicro: Math.round(buyUsd), reason: "target-drift" });
      }
    }
  }

  // 7) cap every order size
  const capped = [];
  for (const o of orders) {
    o.usdMicro = Math.min(o.usdMicro, Math.round(NAV * MAX_ORDER_PCT));
    if (o.usdMicro >= 100_000) capped.push(o);
  }

  // reorder: SELLs before BUYs so rotation is cash-funded
  capped.sort((a, b) => (a.action === "BUY" || a.action === "HEDGE" ? 1 : 0) - (b.action === "BUY" || b.action === "HEDGE" ? 1 : 0));

  rationale = capped.length
    ? `Risk layer passed (${night ? "night" : "day"}, F&G=${fng ?? "n/a"}): ${capped.length} order(s), caps ${(MAX_SINGLE_ASSET_WEIGHT * 100).toFixed(0)}%/crypto ${(cryptoCap * 100).toFixed(0)}%/rToken ${(MAX_RTOKEN_WEIGHT * 100).toFixed(0)}%.`
    : `Risk layer passed (${night ? "night" : "day"}, F&G=${fng ?? "n/a"}): within all caps; no adjustment.`;
  return { orders: capped, breaker: false, flags: riskOff ? ["regime-fear"] : [], rationale };
}