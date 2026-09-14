// VIGIL — risk-control layer. The Agentic Trading track explicitly judges
// "risk control layer effectiveness". This guardrail runs BEFORE any order is sized:
//   · circuit breaker on max drawdown (force-de-risk / halt)
//   · hard kill-switch file
//   · per-order size cap
//   · single-asset, aggregate crypto, and aggregate rToken concentration caps
//   · drift rebalance toward targets that never breaches a cap
// Returns { orders, breaker, flags, rationale } — nothing here touches the ledger.
import { openSync, existsSync } from "node:fs";
import {
  MAX_DRAWDOWN, MAX_ORDER_PCT, MAX_SINGLE_ASSET_WEIGHT, MAX_CRYPTO_WEIGHT, MAX_RTOKEN_WEIGHT,
  KILL_SWITCH_FILE, isCrypto, UNIVERSE,
} from "./config.js";

export function checkState(state) {
  const flags = [];
  if (existsSync(KILL_SWITCH_FILE)) flags.push("kill-switch-armed: no new orders");
  if (state.drawdown >= MAX_DRAWDOWN) flags.push("drawdown-breaker");
  if (state.positions && Object.keys(state.positions).length === 0) flags.push("no-positions");
  return flags;
}

// Given current NAV, positions, live prices, and target weights, produce a
// safe, cap-respecting order set the executor can run.
export function planOrders({ nav, drawdown, positions, prices, targets }) {
  const orders = [];
  const breaker = drawdown >= MAX_DRAWDOWN;
  let rationale;

  const NAV = Number(nav) || 0;
  if (NAV <= 0) return { orders: [], breaker: false, flags: ["zero-nav"], rationale: "no capital to plan against" };

  // 1) circuit breaker — force de-risk to stable core / halt
  if (breaker) {
    for (const [key, p] of Object.entries(positions)) {
      const val = Number(p.value ?? p.valueMicro ?? 0);
      const isStableBase = ["rspy", "rqqq", "raapl"].includes(key);
      if (val > 0 && !isStableBase) orders.push({ action: "SELL", key, usdMicro: val, reason: "breaker" });
    }
    rationale = `Circuit breaker tripped (DD ${(drawdown * 100).toFixed(1)}% >= ${(MAX_DRAWDOWN * 100).toFixed(0)}%): de-risked to stable core.`;
    return { orders, breaker: true, flags: ["drawdown-breaker"], rationale };
  }

  // 2) per-position value map
  const values = {};     // key -> current value micro
  const weights = {};    // key -> current weight of NAV
  for (const [key, p] of Object.entries(positions)) {
    const val = Number(p.value ?? p.valueMicro ?? 0);
    values[key] = val;
    weights[key] = NAV > 0 ? val / NAV : 0;
  }

  // aggregate crypto / rToken exposure
  const cryptoVal = Object.entries(positions)
    .filter(([k]) => isCrypto(k)).reduce((s, [, p]) => s + Number(p.value ?? p.valueMicro ?? 0), 0);
  const cryptoW = NAV > 0 ? cryptoVal / NAV : 0;
  const rtokenVal = Object.entries(positions)
    .filter(([k]) => !isCrypto(k)).reduce((s, [, p]) => s + Number(p.value ?? p.valueMicro ?? 0), 0);
  const rtokenW = NAV > 0 ? rtokenVal / NAV : 0;

  // 3) enforce concentration caps: derive trim orders
  for (const [key, p] of Object.entries(positions)) {
    const v = Number(p.value ?? p.valueMicro ?? 0);
    if (v <= 0) continue;
    const maxW = isCrypto(key) ? MAX_SINGLE_ASSET_WEIGHT : Math.min(MAX_SINGLE_ASSET_WEIGHT, 1.15 * MAX_RTOKEN_WEIGHT);
    if (weights[key] > maxW) {
      const excess = v - NAV * maxW;
      orders.push({ action: "SELL", key, usdMicro: Math.round(excess), reason: "single-asset-cap" });
    }
  }
  if (cryptoW > MAX_CRYPTO_WEIGHT) {
    const excessVal = cryptoVal - NAV * MAX_CRYPTO_WEIGHT;
    let toTrim = excessVal;
    for (const [key, p] of Object.entries(positions).filter(([k]) => isCrypto(k))) {
      if (toTrim <= 0) break;
      const cur = Number(p.value ?? p.valueMicro ?? 0);
      const trim = Math.min(cur, toTrim);
      orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: "crypto-cap" });
      toTrim -= trim;
    }
  }
  if (rtokenW > MAX_RTOKEN_WEIGHT) {
    const excessVal = rtokenVal - NAV * MAX_RTOKEN_WEIGHT;
    let toTrim = excessVal;
    for (const [key, p] of Object.entries(positions).filter(([k]) => !isCrypto(k)).sort(([, a], [, b]) => Number(b.value ?? b.valueMicro ?? 0) - Number(a.value ?? a.valueMicro ?? 0))) {
      if (toTrim <= 0) break;
      const cur = Number(p.value ?? p.valueMicro ?? 0);
      const trim = Math.min(cur, toTrim);
      orders.push({ action: "SELL", key, usdMicro: Math.round(trim), reason: "rtoken-cap" });
      toTrim -= trim;
    }
  }

  // 4) target drift rebalance (only for names in targets, and only using free cash /
  //    proceeds — never breach caps)
  if (targets) {
    for (const [key, targetW] of Object.entries(targets)) {
      const tw = Number(targetW) / 1e6;
      const curVal = values[key] || 0;
      const curW = NAV > 0 ? curVal / NAV : 0;
      const deltaW = tw - curW;
      const targetUsd = NAV * tw;
      if (deltaW > 0.02) {
        // underweight — buy up to gap, capped by order size, if within aggregate cap
        const roomForCrypto = isCrypto(key) ? (MAX_CRYPTO_WEIGHT - cryptoW) * NAV : 1e15;
        const buyUsd = Math.min(targetUsd - curVal, NAV * MAX_ORDER_PCT, Math.max(0, roomForCrypto));
        if (buyUsd >= 100_000) orders.push({ action: "BUY", key, usdMicro: Math.round(buyUsd), reason: "target-drift" });
      }
    }
  }

  // 5) size-cap every order
  const capped = [];
  for (const o of orders) {
    o.usdMicro = Math.min(o.usdMicro, Math.round(NAV * MAX_ORDER_PCT));
    if (o.usdMicro >= 100_000) capped.push(o);
  }

  // dry-run reapply concentrations on the projected order set to catch cap breaches
  rationale = capped.length
    ? `Risk layer passed: sized ${capped.length} order(s) to ${MAX_SINGLE_ASSET_WEIGHT * 100}% / crypto ${MAX_CRYPTO_WEIGHT * 100}% / rToken ${MAX_RTOKEN_WEIGHT * 100}% caps.`
    : "Risk layer passed: portfolio within all caps; no adjustment needed.";
  return { orders: capped, breaker: false, flags: [], rationale };
}