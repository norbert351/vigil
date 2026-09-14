// VIGIL — the autonomous overnight agent loop.
// One sweep = sense (prices + perception) -> reason (LLM) -> hard-risk gate -> execute -> sign.
// The scheduler runs on SCAN_INTERVAL_MS so the paper-trading log is decision-dense
// through the 7-day competition window, with special weight on the "hours humans sleep".
import { EventEmitter } from "node:events";
import { refreshPrices } from "./market.js";
import { portfolioState } from "./engine.js";
import { planOrders } from "./risk.js";
import { executeOrders } from "./executor.js";
import { latestPerception } from "./perception.js";
import { llmFactory } from "./llm.js";
import { clearPositions, getPositions, setAgentState, saveSnapshot, setPosition, logDecision, getAgentState } from "./db.js";
import { DEFAULT_TARGETS, SEED_USD_MICRO as SEED, QTY_SCALE } from "./config.js";

export const agentBus = new EventEmitter();

function currentWindow() {
  const h = new Date().getHours();
  return { window: (h >= 22 || h < 6) ? "night" : "day", hour: h };
}
export { currentWindow };

// First-run seed: allocate SEED across default targets at live prices (fractional units).
export async function maybeSeed(db, targets, prices) {
  const st = db.prepare("SELECT COUNT(*) c FROM positions WHERE qty_micro > 0").get();
  if (Number(st.c) > 0) return false;
  clearPositions(db);
  for (const [key, w] of Object.entries(targets)) {
    const px = prices[key]?.lastMicro;
    if (px == null || px <= 0) continue;
    const usdFor = (SEED * w) / 1_000_000n;
    const qty = (usdFor * QTY_SCALE) / BigInt(Math.round(px)); // micro-units
    if (qty > 0n) setPosition(db, key, qty);
  }
  // baseline = REALIZED deployed NAV (unpriced names leave residual cash) so drawdown starts at 0.
  const realized = portfolioState(getPositions(db), prices).total;
  setAgentState(db, { nav_micro: realized, equity_micro: realized, status: "seeded", last_run_ts: Date.now(), drawdown: 0, breaker_tripped: 0 });
  return true;
}

// Build the full state object handed to the LLM + risk layer.
export async function buildState(db, targets) {
  const prices = await refreshPrices(true);
  const pos = getPositions(db);
  const st = portfolioState(pos, prices);
  const nav = st.total;
  const state0 = getAgentState(db);
  const prevPeak = Number(state0.nav_micro || 0);
  const cur = Number(nav);
  // High-water mark: nav_micro in agent_state is the PEAK (never decreases), so drawdown
  // is (peak - current)/peak and a real 10% drawdown can actually trip the breaker.
  const peak = Math.max(prevPeak, cur, Number(SEED));
  const drawdown = peak > 0 ? Math.max(0, (peak - cur) / peak) : 0;
  const { window, hour } = currentWindow();
  const positions = {};
  for (const [key, d] of Object.entries(st.detail)) {
    positions[key] = {
      qty: d.qty,
      value: d.valueMicro,
      price: d.priceMicro,
      chg24: d.chg24 ?? 0,
      weight: nav > 0 ? Number(d.valueMicro) / Number(nav) : 0,
    };
  }
  return {
    nav: cur,
    peak,
    equity: cur,
    drawdown,
    window,
    hour,
    positions,
    prices,
    targets,
    breaker: Number(state0.breaker_tripped) === 1,
  };
}

// One decision cycle.
export async function runSweep(db, { force = false } = {}) {
  const prices = await refreshPrices(true);
  saveSnapshot(db, JSON.stringify(prices));

  const seeded = await maybeSeed(db, DEFAULT_TARGETS, prices);
  const state = await buildState(db, DEFAULT_TARGETS);
  const { window, hour } = currentWindow();

  // 1) perception (background-refreshed, non-blocking; may be null early — non-fatal)
  const perception = latestPerception();

  const llm = llmFactory();

  // 2) hard risk gate (mandatory)
  const risk = planOrders({
    nav: state.nav, drawdown: state.drawdown, positions: state.positions, prices, targets: state.targets,
  });

  // 3) LLM discretionary decision (ignored entirely if breaker is tripped)
  let llmDecision = null;
  if (!risk.breaker) {
    try {
      const stateForLlm = { ...state, perception, breaker: risk.breaker, window };
      llmDecision = await llm.decide(stateForLlm);
      llmDecision = sanitizeDecision(llmDecision);
    } catch (e) {
      llmDecision = null; // fall back to risk-only
    }
  }

  // 4) merge: breaker -> only risk liquidation; else LLM orders + risk cap orders, capped
  let orders;
  if (risk.breaker) {
    orders = risk.orders;
  } else {
    const map = new Map(); // key -> net buy/sell usdMicro we are directing
    const llmOrders = (llmDecision?.orders || []).map((o) => ({
      action: o.action === "HOLD" ? "HOLD" : o.action,
      key: o.key, usdMicro: Math.round(Number(o.usdMicro || 0)), reason: "llm",
    })).filter((o) => o.action !== "HOLD" && o.usdMicro >= 100_000);
    // risk cap orders are mandatory; LLM orders are discretionary
    orders = mergeOrders(risk.orders, llmOrders, state);
  }

  if (orders.length === 0 && !risk.breaker) {
    // still log a HOLD decision for the paper-trading log
    logDecision(db, {
      ts: Date.now(), window, hash: "-", sentinel: "VIGIL-hold",
      trigger: llmDecision?.trigger || "hold", model: "", llm: llm.mode,
      navMicro: BigInt(state.nav), rationale: llmDecision?.rationale || risk.rationale,
      orders: [], mode: "paper",
    });
    setAgentState(db, { nav_micro: state.peak, drawdown: state.drawdown, status: "held", last_run_ts: Date.now() });
    agentBus.emit("event", { type: "decision", window, trigger: "hold", llm: llm.mode, navMicro: String(state.nav) });
    return { decision: "hold", nav: state.nav, window, seeded };
  }

  // 5) execute + sign + log
  const res = executeOrders(db, {
    orders, trigger: risk.breaker ? "risk" : (llmDecision?.trigger || "rebalance"),
    rationale: risk.breaker ? risk.rationale : (llmDecision?.rationale || risk.rationale),
    window, model: llm.mode === "qwen" ? "qwen3.8-max" : "stub", llm: llm.mode,
    prices, navMicro: BigInt(state.nav),
  });
  const decisionSeq = logDecision(db, {
    ts: Date.now(), window, hash: res.manifest.hash, sentinel: res.manifest.sentinel,
    trigger: risk.breaker ? "risk" : (llmDecision?.trigger || "rebalance"),
    model: llm.mode === "qwen" ? "qwen3.8-max" : "stub", llm: llm.mode,
    navMicro: BigInt(state.nav), rationale: risk.breaker ? risk.rationale : (llmDecision?.rationale || risk.rationale),
    orders: res.executed, mode: res.mode,
  });
  setAgentState(db, {
    nav_micro: state.peak, drawdown: state.drawdown, status: risk.breaker ? "breaker" : "traded",
    last_run_ts: Date.now(), nonce: res.nonce, breaker_tripped: risk.breaker ? 1 : 0,
  });
  agentBus.emit("event", {
    type: "decision", window, trigger: risk.breaker ? "risk" : (llmDecision?.trigger || "traded"),
    llm: llm.mode, navMicro: String(state.nav), hash: res.manifest.hash, orders: res.executed.length,
  });
  return { decision: "traded", nav: state.nav, orders: res.executed.length, hash: res.manifest.hash, window, seeded };
}

function mergeOrders(riskOrders, llmOrders, state) {
  // risk orders win on concentration/breaker; LLM buys use only free proceeds logic loosely.
  // For the paper-agent, merge sells first then buys, both capped by the executor (no oversell).
  const out = [];
  const riskKeys = new Map(riskOrders.map((o) => [o.key, o.action]));
  // start with risk orders (mandatory trims)
  out.push(...riskOrders);
  // add LLM orders unless they collide with a mandatory trim direction for the same key
  for (const o of llmOrders) {
    const existing = riskKeys.get(o.key);
    if (existing === o.action) continue;       // duplicate direction
    if (existing === "SELL" && o.action === "BUY") continue; // don't buy a name being trimmed for a cap
    out.push(o);
  }
  return out;
}

function sanitizeDecision(d) {
  if (!d || typeof d !== "object") return null;
  const orders = (Array.isArray(d.orders) ? d.orders : [])
    .map((o) => ({ action: String(o.action || "HOLD").toUpperCase(), key: String(o.key || ""), usdMicro: Number(o.usdMicro || 0) }))
    .filter((o) => o.key && o.usdMicro > 0 && ["BUY", "SELL", "HEDGE", "LIQUIDATE"].includes(o.action));
  return { trigger: String(d.trigger || "rebalance"), rationale: String(d.rationale || ""), orders };
}

// The overnight scheduler.
export function startAgent(db, intervalMs) {
  const h = setInterval(async () => {
    try { const r = await runSweep(db); agentBus.emit("sweep", r); }
    catch (e) { agentBus.emit("event", { type: "error", msg: String(e.message || e) }); }
  }, intervalMs);
  return { stop: () => clearInterval(h), bus: agentBus };
}