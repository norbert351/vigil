// VIGIL — the autonomous overnight agent loop.
// One sweep = sense (prices + perception) -> reason (LLM) -> hard-risk gate -> execute -> sign.
// Cash-correct: NAV = cash + positions; the equity curve is logged each sweep so the
// paper-trading log supports real Sharpe / max-DD / win-rate analytics.
import { EventEmitter } from "node:events";
import { refreshPrices } from "./market.js";
import { portfolioState } from "./engine.js";
import { planOrders } from "./risk.js";
import { executeOrders, syncLedgerFromVenue } from "./executor.js";
import { latestPerception } from "./perception.js";
import { llmFactory } from "./llm.js";
import {
  flatPositions, setPosition, getCash, setCash, addRealized,
  setAgentState, saveSnapshot, logDecision, getAgentState, logEquity, isKilled, equityCurve,
} from "./db.js";
import { DEFAULT_TARGETS, SEED_USD_MICRO as SEED, QTY_SCALE, FEE_BPS, SLIPPAGE_BPS, EXECUTION_MODE } from "./config.js";
import { crossAssetRegime } from "./regime.js";
import { evaluateSweepAlerts } from "./alerts.js";

export const agentBus = new EventEmitter();
const TENK = 10_000n;
const FEE = BigInt(FEE_BPS), SLIP = BigInt(SLIPPAGE_BPS);
const buyCost = (n) => n + (n * FEE) / TENK;

export function currentWindow() {
  const h = new Date().getHours();
  return { window: (h >= 22 || h < 6) ? "night" : "day", hour: h };
}

// First-run: allocate SEED across default targets at live prices, WITH fees, funding
// each buy from cash; residual stays as USDT cash. Sets the peak = SEED so drawdown starts at 0.
export async function maybeSeed(db, targets, prices) {
  const r = db.prepare("SELECT COUNT(*) c FROM positions WHERE qty_micro > 0").get();
  if (Number(r.c) > 0) return false;
  db.prepare("DELETE FROM positions").run();
  let cash = SEED;
  for (const [key, w] of Object.entries(targets)) {
    const px = prices[key]?.lastMicro;
    if (px == null || px <= 0) continue;
    const lvl = BigInt(Math.round(px)) + (BigInt(Math.round(px)) * SLIP) / TENK; // buy slip
    const want = (SEED * w) / 1_000_000n; // target notional (micro-USD)
    const maxN = (cash * TENK) / (TENK + FEE); // most cash can fund after fee
    const targetN = want < maxN ? want : maxN;
    if (targetN <= 0n) continue;
    const qty = (targetN * QTY_SCALE) / lvl;
    if (qty <= 0n) continue;
    const notional = (qty * lvl) / QTY_SCALE;
    const cost = buyCost(notional);
    if (cost > cash) continue;
    setPosition(db, key, qty, cost / qty);
    cash -= cost;
  }
  setCash(db, cash);
  const posVal = portfolioState(flatPositions(db), prices).total;
  setAgentState(db, { nav_micro: SEED, equity_micro: posVal + cash, cash_micro: cash, realized_pnl_micro: 0n, status: "seeded", last_run_ts: Date.now(), drawdown: 0, breaker_tripped: 0, kill_switched: 0 });
  return true;
}

// Full live state handed to the LLM + risk layer. NAV = cash + positions.
export async function buildState(db) {
  const prices = await refreshPrices(true);
  const pos = flatPositions(db);
  const st = portfolioState(pos, prices);
  const cash = getCash(db);
  const nav = st.total + cash;
  const state0 = getAgentState(db);
  const prevPeak = Number(state0.nav_micro || 0);
  const cur = Number(nav);
  const peak = Math.max(prevPeak, cur, Number(SEED));
  const drawdown = peak > 0 ? Math.max(0, (peak - cur) / peak) : 0;
  const { window, hour } = currentWindow();
  const positions = {};
  for (const [key, d] of Object.entries(st.detail)) {
    positions[key] = { qty: d.qty, value: d.valueMicro, price: d.priceMicro, chg24: d.chg24 ?? 0, weight: nav > 0 ? Number(d.valueMicro) / Number(nav) : 0 };
  }
  return {
    nav: cur, peak, cash: Number(cash), equity: cur, drawdown, window, hour, positions, prices,
    targets: DEFAULT_TARGETS, breaker: Number(state0.breaker_tripped) === 1, killed: isKilled(db),
  };
}

// Build the signed context (what the agent saw) for event → decision traceability.
function decisionContext(state, perception) {
  const news = (perception?.news || []).slice(0, 3).map((n) => n.title || n).filter(Boolean);
  return {
    window: state.window, hour: state.hour, navMicro: Math.round(state.nav), cashMicro: Math.round(state.cash),
    drawdown: state.drawdown, fearGreed: perception?.fearGreed || null, regime: state.regime || null,
    news, macro: perception?.macro || null,
    targets: Object.fromEntries(Object.entries(state.targets || {}).map(([k, v]) => [k, (Number(v) / 1e6).toFixed(2)])),
  };
}

// The model + mode used to produce a decision (for the signed log).
function llmModel(llm) { return llm.provider && llm.mode !== "stub" ? [llm.model, llm.provider].filter(Boolean).join(" @ ") : "deterministic-stub"; }

// One decision cycle.
export async function runSweep(db, { force = false, venue, execMode, webhook, llm: llmOverride } = {}) {
  const mode = execMode || EXECUTION_MODE;
  const prices = await refreshPrices(true);
  saveSnapshot(db, JSON.stringify(prices));
  // NAV before this sweep — used by the break-glass alert layer
  let prevNav = 0;
  try { const c = equityCurve(db, 5); if (c.length) prevNav = Number(c[c.length - 1].nav_micro); } catch { /* fresh */ }
  const venueMode = mode === "bitget";
  // bitget mode: the venue IS the account — sync ledger from venue truth, no paper seed.
  if (venueMode) {
    try {
      await syncLedgerFromVenue(db, prices, venue);
      // a fresh venue account with zero positions starts the peak at current balance
      const st0 = getAgentState(db);
      const nav0 = portfolioState(flatPositions(db), prices).total + getCash(db);
      if (Number(st0.nav_micro || 0) === 0 && nav0 > 0n) {
        setAgentState(db, { nav_micro: Number(nav0), status: "seeded", last_run_ts: Date.now(), drawdown: 0 });
      }
    } catch (e) { console.error("venue sync", e.message); }
  }
  const seeded = venueMode ? false : await maybeSeed(db, DEFAULT_TARGETS, prices);
  const state = await buildState(db);
  const perception = latestPerception();
  state.perception = perception;
  state.regime = crossAssetRegime(state.prices, perception?.fearGreed?.value ?? null);
  const llm = llmOverride || llmFactory();
  const modelLabel = llmModel(llm);
  const fearGreed = perception?.fearGreed?.value ?? null;

  // hard risk gate (mandatory) — night + regime aware
  const risk = planOrders({
    nav: state.nav, drawdown: state.drawdown, positions: state.positions, prices,
    targets: state.targets, night: state.window === "night", fearGreed, killed: state.killed,
  });

  // LLM discretionary decision (ignored entirely if breaker / killed)
  let llmDecision = null;
  if (!risk.breaker && !state.killed) {
    try {
      const stateForLlm = { ...state, perception, breaker: risk.breaker, killed: state.killed, window: state.window };
      llmDecision = await llm.decide(stateForLlm);
      llmDecision = sanitizeDecision(llmDecision);
    } catch (e) { llmDecision = null; }
  }

  // TWO-MODEL AUDIT: a second reviewer criticizes the discretionary plan before
  // execution. On reject → drop the LLM's orders (risk layer orders always survive);
  // the verdict + reason ride into the signed decision log.
  let review = null;
  if (llmDecision && ((llmDecision.orders || []).length > 0) && !risk.breaker && !state.killed) {
    try {
      review = await llm.review({ state, decision: llmDecision });
      review = { verdict: String(review?.verdict || "reject").toLowerCase() === "pass" ? "pass" : "reject", reason: String(review?.reason || "") };
      if (review.verdict === "reject") {
        llmDecision = { ...llmDecision, orders: [], rejectedReason: review.reason };
      }
    } catch (e) { review = null; }
  }

  let orders;
  if (risk.breaker || state.killed) {
    orders = risk.orders; // breaker liquidation / kill = halt
  } else {
    const llmOrders = (llmDecision?.orders || []).map((o) => ({ action: o.action, key: o.key, usdMicro: Math.round(Number(o.usdMicro || 0)), reason: "llm-" + (o.action || "hold") })).filter((o) => o.usdMicro >= 100_000);
    orders = mergeOrders(risk.orders, llmOrders, state);
  }

  const context = decisionContext(state, perception);
  const navMicro = BigInt(Math.round(state.nav));
  const trigger = risk.breaker ? "risk" : state.killed ? "killed" : (llmDecision?.trigger || (orders.filter((o) => o.action && o.action !== "HOLD").length ? "rebalance" : "hold"));
  const rationale = risk.breaker ? risk.rationale : state.killed ? "Kill-switch armed — averted." : ((llmDecision?.rationale || risk.rationale || ""));

  if (orders.length === 0) {
    const holdTrigger = state.killed ? "killed" : risk.breaker ? "risk" : "hold";
    const auditNote = review && review.verdict === "reject" && llmDecision?.rejectedReason
      ? `Auditor rejected the proposal: ${llmDecision.rejectedReason}`
      : null;
    logDecision(db, {
      ts: Date.now(), window: state.window, hash: "-", sentinel: "VIGIL-hold", trigger: holdTrigger, model: modelLabel, llm: llm.mode, navMicro,
      rationale: auditNote ? `${rationale} ${auditNote}` : rationale, context, orders: [], mode,
      reviewVerdict: review?.verdict || null, reviewRationale: review?.reason || (auditNote || null),
    });
    setAgentState(db, { nav_micro: state.peak, cash_micro: state.cash, drawdown: state.drawdown, status: state.killed ? "killed" : "held", last_run_ts: Date.now() });
    logEquity(db, Date.now(), navMicro, BigInt(Math.round(state.cash)));
    agentBus.emit("event", { type: "decision", window: state.window, trigger: holdTrigger, llm: llm.mode, navMicro: state.nav.toString() });
    // break-glass alerts (breaker / kill / outsized move)
    await evaluateSweepAlerts(db, { result: { breaker: risk.breaker, decision: holdTrigger }, state, prevNav, webhook }).catch(() => {});
    return { decision: holdTrigger, nav: state.nav, window: state.window, seeded };
  }

  const res = await executeOrders(db, { orders, trigger, rationale, window: state.window, model: modelLabel, llm: llm.mode, prices, navMicro, context, venue, execMode: mode });
  logDecision(db, {
    ts: Date.now(), window: state.window, hash: res.manifest.hash, sentinel: res.manifest.sentinel, trigger, model: modelLabel, llm: llm.mode, navMicro, rationale, context, orders: res.executed, mode: res.mode,
    reviewVerdict: review?.verdict || null, reviewRationale: review?.reason || null,
  });
  setAgentState(db, { nav_micro: state.peak, cash_micro: getCash(db), drawdown: state.drawdown, status: risk.breaker ? "breaker" : "traded", last_run_ts: Date.now(), nonce: res.nonce, breaker_tripped: risk.breaker ? 1 : 0 });
  logEquity(db, Date.now(), navMicro, getCash(db));
  agentBus.emit("event", { type: "decision", window: state.window, trigger, llm: llm.mode, navMicro: state.nav.toString(), hash: res.manifest.hash, orders: res.executed.length });
  // break-glass alerts (breaker / kill / outsized move / venue failures)
  const vstats = globalThis.__vigilVenueStats || {};
  await evaluateSweepAlerts(db, { result: { breaker: risk.breaker, decision: trigger, venueErrors: vstats.venueErrors || 0 }, state, prevNav, webhook }).catch(() => {});
  return { decision: "traded", nav: state.nav, orders: res.executed.length, hash: res.manifest.hash, window: state.window, seeded };
}

function mergeOrders(riskOrders, llmOrders, state) {
  const out = [...riskOrders]; // risk wins on caps/breaker
  const riskKeys = new Map(riskOrders.map((o) => [o.key, o.action]));
  for (const o of llmOrders) {
    const existing = riskKeys.get(o.key);
    if (existing === o.action) continue;
    if (existing === "SELL" && o.action === "BUY") continue;
    if (!state.positions[o.key] && o.action === "HOLD") continue;
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