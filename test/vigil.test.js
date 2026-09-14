import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
process.env.VIGIL_DB_PATH = ":memory:"; // isolated in-memory ledger for tests
import { portfolioState, signManifest, decisionId } from "../src/engine.js";
import { planOrders } from "../src/risk.js";
import { executeOrders } from "../src/executor.js";
import { openDB, getPositions, getAgentState, logDecision, listDecisions } from "../src/db.js";
import { decideStub } from "../src/llm.js";

// Synthetic price map in the market.js shape: { key: { lastMicro, chg24 } }
const PX = {
  rtsla: { lastMicro: 359_770_000, chg24: 0.01 },
  rnvda: { lastMicro: 212_250_000, chg24: -0.03 },
  raapl: { lastMicro: 332_700_000, chg24: 0.0 },
  btc:   { lastMicro: 77_920_760_000, chg24: -0.02 },
  eth:   { lastMicro: 2_514_200_000, chg24: 0.02 },
  rspy:  { lastMicro: 759_340_000, chg24: 0.005 },
  rqqq:  { lastMicro: 703_910_000, chg24: -0.01 },
};
const ONE_MICRO = 1_000_000n;
const target = { rtsla: 200_000n, rnvda: 200_000n, raapl: 150_000n, btc: 200_000n, eth: 100_000n, rspy: 50_000n, rqqq: 100_000n };

function freshDb() {
  const db = openDB(); // uses VIGIL_DB_PATH or ./vigil.sqlite
  db.prepare("DELETE FROM positions").run();
  db.prepare("DELETE FROM decisions").run();
  db.prepare("DELETE FROM orders").run();
  return db;
}

test("engine.portfolioState values fractional micro-units correctly", () => {
  // 0.7979 ETH (797900 micro-units) @ 2514.20 should be ~$2006
  const pos = { eth: 797_900n };
  const st = portfolioState(pos, PX);
  assert.equal(st.detail.eth.valueUsd > 1900 && st.detail.eth.valueUsd < 2100, true);
  // price consistency
  assert.equal(Number(st.detail.eth.valueMicro) / 1e6, st.detail.eth.valueUsd);
});

test("engine.signManifest is deterministic and tamper-evident", () => {
  const a = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_000n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub" });
  const b = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_000n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub" });
  const c = signManifest({ window: "day", nonce: 1, ts: 1, navMicro: 10_000_000_001n, trigger: "hold", prices: PX, orders: [], model: "stub", llm: "stub" });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.match(a.sentinel, /^VIGIL-[0-9a-f]{12}$/);
});

test("risk.planOrders trips the breaker on heavy drawdown and liquidates risk assets", () => {
  const positions = { rtsla: 5_000_000n, btc: 2_000_000n, rcoin: 1_000_000n };
  const r = planOrders({ nav: 5_000_000_000, drawdown: 0.42, positions: { rtsla: { value: 2_000_000_000 }, btc: { value: 2_000_000_000 }, rcoin: { value: 1_000_000_000 } }, prices: PX, targets: null });
  assert.equal(r.breaker, true);
  for (const o of r.orders) assert.equal(o.action, "SELL");
});

test("risk.planOrders limits any single order to MAX_ORDER_PCT of NAV", () => {
  const positions = { rtsla: { value: 2_000_000_000 }, btc: { value: 8_000_000_000 } };
  const r = planOrders({ nav: 10_000_000_000, drawdown: 0, positions, prices: PX, targets: null });
  for (const o of r.orders) assert.ok(o.usdMicro <= 1_500_000_000, "no order > 15% NAV");
});

test("executor never oversells a position", () => {
  const db = freshDb();
  db.prepare("INSERT INTO positions (key, qty_micro) VALUES (?,?)").run("rtsla", "1000000");
  const posBefore = getPositions(db).rtsla;
  const res = executeOrders(db, {
    orders: [{ action: "SELL", key: "rtsla", usdMicro: 1_000_000_000_000 }], // $1M sell vs tiny holding
    trigger: "risk", rationale: "test", window: "day", model: "stub", llm: "stub",
    prices: PX, navMicro: 1_000_000_000n,
  });
  const posAfter = getPositions(db).rtsla;
  assert.ok(posAfter >= 0n, "no negative qty after oversell attempt");
  assert.equal(res.manifest.sentinel.startsWith("VIGIL-"), true);
});

test("executor buys and records signed order rows", () => {
  const db = freshDb();
  const res = executeOrders(db, {
    orders: [{ action: "BUY", key: "rnvda", usdMicro: 2_000_000_000 }], // $2000 of NVDA
    trigger: "rebalance", rationale: "test", window: "night", model: "stub", llm: "stub",
    prices: PX, navMicro: 10_000_000_000n,
  });
  assert.equal(res.executed.length, 1);
  assert.equal(res.executed[0].action, "BUY");
  assert.ok(getPositions(db).rnvda > 0n);
});

test("db logs a decision and it is readable from the decision log", () => {
  const db = freshDb();
  const seq = logDecision(db, {
    ts: Date.now(), window: "night", hash: "abc", sentinel: "VIGIL-abc", trigger: "macro",
    model: "qwen3.8-max", llm: "qwen", navMicro: 10_000_000_000n, rationale: "test", orders: [{ action: "SELL", key: "btc", qtyMicro: 100n, usdMicro: 1_000_000n, pxMicro: 77_920_760_000n, detail: "x" }], mode: "paper",
  });
  assert.ok(seq > 0);
  const rows = listDecisions(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sentinel, "VIGIL-abc");
  assert.equal(rows[0].window, "night");
});

test("llm.decideStub trims a sharp 24h laggard and holds otherwise", async () => {
  // rnvda down 3% beyond the -2.5% trigger
  const state = {
    nav: 10_000_000_000, window: "day", drawdown: 0.01, breaker: false,
    positions: { rnvda: { qty: 9_000_000n, value: 1_900_000_000, price: 212_250_000, chg24: -0.03 }, rspy: { qty: 1_000_000n, value: 800_000_000, price: 759_340_000, chg24: 0.0 } },
    perception: null, targets: target,
  };
  const d = await decideStub(state);
  assert.ok(d.orders.some((o) => o.action === "SELL" && o.key === "rnvda"), "should trim the laggard");

  const calm = { ...state, positions: { rtsla: { qty: 1n, value: 1_000_000_000, chg24: 0.01 } } };
  const d2 = await decideStub(calm);
  assert.equal(d2.trigger, "hold");
});

test("breaker: llm discretionary decisions are ignored in favor of the risk liquidation", async () => {
  const state = {
    nav: 5_000_000_000, window: "day", drawdown: 0.5, breaker: true,
    positions: { rtsla: { qty: 1n, value: 2_000_000_000, chg24: 0.01 }, btc: { qty: 1n, value: 3_000_000_000, chg24: 0.02 } },
    perception: null, targets: target,
  };
  const d = await decideStub(state);
  assert.equal(d.trigger, "risk");
  assert.ok(d.orders.every((o) => o.action === "SELL"));
});