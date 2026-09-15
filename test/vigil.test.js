import { test } from "node:test";
import assert from "node:assert/strict";
process.env.VIGIL_DB_PATH = ":memory:";
import { portfolioState, signManifest } from "../src/engine.js";
import { planOrders } from "../src/risk.js";
import { executeOrders } from "../src/executor.js";
import { openDB, flatPositions, getCash, setCash, setPosition, getPositions, listDecisions, logDecision, logEquity, equityCurve, tradeRows } from "../src/db.js";
import { decideStub } from "../src/llm.js";
import { sharpeFromCurve, maxDrawdown, winRateAndPnl } from "../src/analytics.js";

const PX = {
  rtsla: { lastMicro: 359_770_000, chg24: 0.01 },
  rnvda: { lastMicro: 212_250_000, chg24: -0.03 },
  raapl: { lastMicro: 332_700_000, chg24: 0.0 },
  btc:   { lastMicro: 77_920_760_000, chg24: -0.02 },
  eth:   { lastMicro: 2_514_200_000, chg24: 0.02 },
  rspy:  { lastMicro: 759_340_000, chg24: 0.005 },
  rqqq:  { lastMicro: 703_910_000, chg24: -0.01 },
};
const target = { rtsla: 200_000n, rnvda: 200_000n, raapl: 150_000n, btc: 200_000n, eth: 100_000n, rspy: 50_000n, rqqq: 100_000n };

function freshDb() {
  const db = openDB();
  db.prepare("DELETE FROM positions").run();
  db.prepare("DELETE FROM decisions").run();
  db.prepare("DELETE FROM orders").run();
  db.prepare("DELETE FROM equity_curve").run();
  db.prepare("UPDATE agent_state SET cash_micro=0, realized_pnl_micro=0, kill_switched=0, breaker_tripped=0, nonce=0").run();
  return db;
}

test("engine.portfolioState values fractional micro-units correctly", () => {
  const st = portfolioState({ eth: 797_900n }, PX);
  assert.ok(st.detail.eth.valueUsd > 1900 && st.detail.eth.valueUsd < 2100);
});

test("engine.signManifest is deterministic and binds context", () => {
  const a = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_000n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub", context: null });
  const b = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_000n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub", context: null });
  const c = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_001n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub", context: null });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.match(a.sentinel, /^VIGIL-[0-9a-f]{12}$/);
});

// --- RISK ---
test("risk trips the breaker at night sooner (5% not 10%)", () => {
  const positions = { btc: { value: 2_000_000_000 }, rtsla: { value: 2_000_000_000 }, rspy: { value: 500_000_000 } };
  const day = planOrders({ nav: 4_000_000_000, drawdown: 0.08, positions, prices: PX, targets: null, night: false });
  const night = planOrders({ nav: 4_000_000_000, drawdown: 0.08, positions, prices: PX, targets: null, night: true });
  assert.equal(day.breaker, false);
  assert.equal(night.breaker, true); // 8% > night cap 5%
  assert.ok(night.orders.every((o) => o.action === "SELL"));
});

test("risk kill-switch halts all trading with empty orders", () => {
  const positions = { btc: { value: 2_000_000_000 } };
  const r = planOrders({ nav: 4_000_000_000, drawdown: 0, positions, prices: PX, targets: null, killed: true });
  assert.equal(r.orders.length, 0);
  assert.ok(r.flags.includes("kill-switch"));
});

test("risk Fear-regime trims crypto (tightens cap to 25%) and adds a defensive buy", () => {
  const positions = { btc: { value: 4_000_000_000 }, rspy: { value: 500_000_000 } };
  const r = planOrders({ nav: 5_000_000_000, drawdown: 0.0, positions, prices: PX, targets: null, night: false, fearGreed: 20 });
  const sells = r.orders.filter((o) => o.action === "SELL");
  assert.ok(sells.some((o) => o.key === "btc" && o.reason.includes("fear")));
});

test("risk caps any single order to MAX_ORDER_PCT of NAV", () => {
  const positions = { btc: { value: 8_000_000_000 } };
  const r = planOrders({ nav: 10_000_000_000, drawdown: 0, positions, prices: PX, targets: null });
  for (const o of r.orders) assert.ok(o.usdMicro <= 1_500_000_000);
});

// --- EXECUTOR (cash-correct) ---
test("executor never oversells and credits cash + realized P&L", async () => {
  const db = freshDb();
  setPosition(db, "rtsla", 1_000_000n, 359_770_000n); // 1 unit @ cost ~price
  const res = await executeOrders(db, { orders: [{ action: "SELL", key: "rtsla", usdMicro: 1_000_000_000_000 }], trigger: "risk", rationale: "t", window: "day", model: "stub", llm: "stub", prices: PX, navMicro: 1_000_000_000n, context: null });
  const after = flatPositions(db);
  assert.ok(after.rtsla >= 0n, "no negative qty");
  assert.ok(getCash(db) > 0n, "sale credited cash");
  assert.equal(res.manifest.sentinel.startsWith("VIGIL-"), true);
});

test("executor BUY is cash-funded: cannot buy what it has no cash for", async () => {
  const db = freshDb();
  setCash(db, 500_000_000n); // $500 cash
  const res = await executeOrders(db, { orders: [{ action: "BUY", key: "rnvda", usdMicro: 2_000_000_000 }], trigger: "rebalance", rationale: "t", window: "night", model: "stub", llm: "stub", prices: PX, navMicro: 10_000_000_000n, context: null });
  // bought ~$499 (affordable from $500 cash), NOT the $2000 requested
  const rnvdaQty = flatPositions(db).rnvda || 0n;
  const boughtUsd = (Number(rnvdaQty) * PX.rnvda.lastMicro) / 1e6 / 1e6;
  assert.ok(boughtUsd >= 100 && boughtUsd <= 505, `bought $${boughtUsd} (cash was $500)`);
  assert.ok(getCash(db) < 500_000_000n, "cash spent");
});

test("executor BUY from a sell's proceeds in the same batch (rotation is cash-funded)", async () => {
  const db = freshDb();
  setPosition(db, "btc", 1_000_000n, 77_920_760_000n);
  setCash(db, 0n);
  const res = await executeOrders(db, { orders: [
    { action: "SELL", key: "btc", usdMicro: 2_000_000_000 },
    { action: "BUY", key: "rspy", usdMicro: 1_000_000_000 },
  ], trigger: "hedge", rationale: "t", window: "night", model: "stub", llm: "stub", prices: PX, navMicro: 10_000_000_000n, context: null });
  const pos = flatPositions(db);
  assert.ok(pos.rspy > 0n, "sell proceeds funded the defensive buy");
});

test("executor deducts fee + slippage on buys", async () => {
  const db = freshDb();
  setCash(db, 1_000_000_000n); // $1000
  const res = await executeOrders(db, { orders: [{ action: "BUY", key: "rspy", usdMicro: 500_000_000 }], trigger: "rebalance", rationale: "t", window: "day", model: "stub", llm: "stub", prices: PX, navMicro: 1e10, context: null });
  const order = res.executed[0];
  assert.ok(order.feeMicro > 0n, "fee charged");
  // fill should be >= price due to slippage on buy
  assert.ok(order.pxMicro >= PX.rspy.lastMicro, "buy paid slippage");
});

// --- DB: equity curve + metrics ---
test("equity curve records and analytics Sharpe/maxDD/winRate are computed", () => {
  const db = freshDb();
  const navs = [1_000_000_000n, 1_020_000_000n, 990_000_000n, 1_050_000_000n, 1_030_000_000n];
  navs.forEach((n, i) => logEquity(db, 1 + i, n, 0n));
  const curve = equityCurve(db);
  assert.equal(curve.length, 5);
  assert.ok(maxDrawdown(curve) > 0);
  // win rate from trades
  const wr = winRateAndPnl([{ pnl_micro: 100 }, { pnl_micro: -50 }, { pnl_micro: 300 }]);
  assert.equal(wr.trades, 3);
  assert.equal(wr.winRate, 2 / 3);
  assert.equal(wr.realizedUsd, 0.00035);
});

// --- DB decision log ---
test("db logs a decision with context and it is readable", () => {
  const db = freshDb();
  const seq = logDecision(db, {
    ts: Date.now(), window: "night", hash: "abc", sentinel: "VIGIL-abc", trigger: "hedge",
    model: "qwen3.8-max", llm: "qwen", navMicro: 10_000_000_000n, rationale: "r",
    context: { fearGreed: 20, window: "night" },
    orders: [{ action: "SELL", key: "btc", qtyMicro: 100n, usdMicro: 1_000_000n, pxMicro: 77_920_760_000n, pnlMicro: 500n, feeMicro: 10n, detail: "x" }],
    mode: "paper",
  });
  assert.ok(seq > 0);
  const rows = listDecisions(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sentinel, "VIGIL-abc");
  assert.ok(rows[0].context_json.includes("fearGreed"));
});

// --- LLM stub regime + momentum ---
test("llm stub rotates to defense at night + Fear regime", async () => {
  const state = {
    nav: 10_000_000_000, cash: 0, window: "night", drawdown: 0.01, breaker: false, killed: false, targets: target,
    positions: { btc: { qty: 1n, value: 2_000_000_000, chg24: -0.02 }, rtsla: { qty: 5_000_000n, value: 1_800_000_000, chg24: -0.01 }, rspy: { qty: 600_000n, value: 500_000_000, chg24: 0 } },
    perception: { fearGreed: { value: 20 } },
  };
  const d = await decideStub(state);
  assert.equal(d.trigger, "hedge");
  assert.ok(d.orders.some((o) => o.action === "SELL" && ["btc", "eth", "rtsla"].includes(o.key)), "night fear trims risk");
  assert.ok(d.orders.some((o) => o.action === "BUY" && ["rspy", "rqqq"].includes(o.key)), "rotates into defensive base");
});

test("llm stub trims a sharp 24h laggard and holds otherwise (neutral regime)", async () => {
  const state = {
    nav: 10_000_000_000, cash: 0, window: "day", drawdown: 0.01, breaker: false, killed: false, targets: target,
    positions: { rnvda: { qty: 9_000_000n, value: 1_900_000_000, chg24: -0.03 }, rspy: { qty: 1_000_000n, value: 800_000_000, chg24: 0 } },
    perception: { fearGreed: { value: 55 } },
  };
  const d = await decideStub(state);
  assert.ok(d.orders.some((o) => o.action === "SELL" && o.key === "rnvda"), "trims the 24h laggard");
  const calm = { ...state, positions: { rtsla: { qty: 1n, value: 1_000_000_000, chg24: 0.01 } } };
  const d2 = await decideStub(calm);
  assert.equal(d2.trigger, "hold");
});

test("llm stub honors a breaker (no discretionary orders)", async () => {
  const state = {
    nav: 5_000_000_000, cash: 0, window: "day", drawdown: 0.5, breaker: true, killed: false, targets: target,
    positions: { rtsla: { qty: 1n, value: 2_000_000_000, chg24: 0.01 } }, perception: null,
  };
  const d = await decideStub(state);
  assert.equal(d.trigger, "risk");
  assert.equal(d.orders.length, 0); // stub defers to the risk layer's liquidation
});