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
// --- VENUE helpers (pure, no network) ---
import { floorTo, roundTo, venueSymbol, toSizeUsd, toSizeBase } from "../src/venue.js";

test("venue.floorTo respects precision and never overshoots", () => {
  assert.equal(floorTo("0.2935000000", 4), "0.2935");
  assert.equal(floorTo("0.00123456", 4), "0.0012");
  assert.equal(floorTo("3.19999999", 2), "3.19");
  assert.equal(floorTo("1.000000000", 4), "1");
});

test("venue.roundTo respects precision", () => {
  assert.equal(roundTo("3.141592", 2), "3.14");
  assert.equal(roundTo("2.995", 2), "3");
  assert.equal(roundTo("0.00009999", 4), "0.0001");
});

test("venue maps universe keys to Bitget symbols", () => {
  assert.equal(venueSymbol("btc"), "BTCUSDT");
  assert.equal(venueSymbol("eth"), "ETHUSDT");
  assert.equal(venueSymbol("rtsla"), "RTSLAUSDT");
  assert.equal(venueSymbol("rspy"), "RSPYUSDT");
  assert.equal(venueSymbol("nope"), null);
});

test("venue size helpers convert micro-units to venue decimal strings", () => {
  assert.equal(toSizeUsd(5_000_000n), "5"); // $5
  assert.equal(toSizeUsd(1_234_567n), "1.234567");
  const base = toSizeBase(1_000_000_000n, 500_000_000n); // 1 token @ $500
  assert.ok(Math.abs(Number(base) - 2) < 0.000001, `base=$base`);
});

// --- SESSIONS (multi-user Connect) ---
import { encryptCreds, decryptCreds, SessionError } from "../src/sessions.js";
import { probeDemoKey } from "../src/venue.js";

test("session creds encrypt/decrypt round-trips (AES-256-GCM)", () => {
  const creds = { apiKey: "bg_test", secret: "s3cret", passphrase: "phrase123" };
  const enc = encryptCreds(creds);
  assert.equal(enc.startsWith("v1:"), true);
  assert.equal(enc.includes("bg_test"), false, "plaintext must not be stored");
  const dec = decryptCreds(enc);
  assert.deepEqual(dec, creds);
});

test("session creds reject tampered payloads", () => {
  const enc = encryptCreds({ apiKey: "a", secret: "b", passphrase: "c" });
  const parts = enc.split(":");
  parts[2] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptCreds(parts.join(":")), SessionError);
});

test("probeDemoKey rejects missing creds cleanly", async () => {
  const r = await probeDemoKey({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/i);
});

// --- TWO-MODEL AUDIT ---
import { reviewStub } from "../src/llm.js";

test("auditor rejects a buy while the breaker is armed", () => {
  const r = reviewStub({ state: { nav: 1e10, cash: 1e9, breaker: true }, decision: { orders: [{ action: "BUY", key: "btc", usdMicro: 1e8 }] } });
  assert.equal(r.verdict, "reject");
  assert.match(r.reason, /breaker/i);
});

test("auditor rejects orders above 25% of NAV and malformed orders", () => {
  const big = reviewStub({ state: { nav: 1e10, cash: 1e10, breaker: false }, decision: { orders: [{ action: "BUY", key: "rnvda", usdMicro: 5e9 }] } });
  assert.equal(big.verdict, "reject");
  // cash-affordability is owned + enforced by the executor, not the auditor
  const affordable = reviewStub({ state: { nav: 1e10, cash: 1e8, breaker: false }, decision: { orders: [{ action: "BUY", key: "rspy", usdMicro: 5e8 }] } });
  assert.equal(affordable.verdict, "pass");
});

test("auditor passes a conservative de-risk and flags malformed orders", () => {
  const ok = reviewStub({ state: { nav: 1e10, cash: 1e9, breaker: false }, decision: { orders: [{ action: "SELL", key: "btc", usdMicro: 5e8 }] } });
  assert.equal(ok.verdict, "pass");
  const bad = reviewStub({ state: { nav: 1e10, cash: 1e9, breaker: false }, decision: { orders: [{ action: "", key: "", usdMicro: 0 }] } });
  assert.equal(bad.verdict, "reject");
});

// --- TIMELINE ---
import { buildTimeline } from "../src/timeline.js";

test("timeline merges decisions, news and nav into one ordered axis", () => {
  const db = freshDb();
  logDecision(db, { ts: Date.now() - 60000, window: "night", hash: "h", sentinel: "VIGIL-abc",
    trigger: "hedge", model: "m", llm: "live", navMicro: 1e10, rationale: "rotated",
    context: { news: [{ title: "CPI hot" }], fearGreed: 22 }, orders: [{ action: "SELL", key: "btc" }], mode: "bitget" });
  logEquity(db, Date.now() - 60000, 1e10, 1e9);
  logEquity(db, Date.now(), 1.01e10, 1e9);
  const t = buildTimeline(db, { hours: 24 });
  assert.ok(t.events.length >= 3, `events=${t.events.length}`);
  const kinds = t.events.map((e) => e.kind);
  assert.ok(kinds.includes("decision") && kinds.includes("news") && kinds.includes("macro"));
  assert.equal(t.counts.trades, 1);
  assert.ok(t.events.every((e, i) => i === 0 || e.ts >= t.events[i - 1].ts), "events sorted by time");
});

// --- LEADERBOARD ---
import { rankBooks, scoreBook } from "../src/leaderboard.js";

test("leaderboard ranks by return then decisions", () => {
  const ranked = rankBooks([
    { name: "A", returnPct: 1.0, sharpe: null, decisions: 5 },
    { name: "B", returnPct: 3.5, sharpe: null, decisions: 2 },
    { name: "C", returnPct: -2.0, sharpe: null, decisions: 9 },
  ]);
  assert.deepEqual(ranked.map((b) => b.name), ["B", "A", "C"]);
  assert.equal(ranked[0].rank, 1);
});

test("leaderboard scores a book from its own ledger", () => {
  const db = freshDb();
  setCash(db, 5_500_000_000n);                                    // current: $5,500
  logEquity(db, Date.now() - 1000, 5_000_000_000n, 5_000_000_000n); // first observation: $5,000
  logEquity(db, Date.now(), 5_500_000_000n, 5_500_000_000n);
  const s = scoreBook(db, { id: "t", name: "Test", prices: PX });
  assert.ok(s.nav > 0, `nav=${s.nav}`);
  assert.equal(s.startNav, 5000);
  assert.ok(Math.abs(s.returnPct - 10) < 0.01, `return=${s.returnPct}`);
});

// --- TWO-MODEL AUDIT end-to-end in the agent loop ---
import { runSweep } from "../src/agent.js";

test("agent loop: auditor REJECTS an oversize LLM plan and logs the verdict", async () => {
  const db = freshDb();
  setPosition(db, "rtsla", 10_000_000n, 359_770_000n);  // ~$3,600 held (blocks the paper seed)
  setCash(db, 8_000_000_000n);                          // $8,000 free cash → NAV ≈ $11,600
  const sneaky = {
    mode: "live", model: "test-model", provider: "test", reviewerModel: "test-audit",
    decide: async () => ({ trigger: "rebalance", rationale: "all-in on one name", orders: [{ action: "BUY", key: "rnvda", usdMicro: 7_000_000_000 }] }),
    review: reviewStub,
  };
  await runSweep(db, { execMode: "paper", llm: sneaky });
  const dec = listDecisions(db, 1)[0];
  const logged = JSON.parse(dec.orders_json || "[]");
  assert.equal(dec.review_verdict, "reject", "audit verdict must be logged");
  assert.match(dec.review_rationale || "", /25% of NAV|exceeds/i);
  // the rejected $7,000 order must not appear; every logged order stays inside the cap
  assert.ok(!logged.some((o) => Number(o.usdMicro || 0) >= 7_000_000_000), "rejected order must NOT execute");
  const nav = Number(dec.nav_micro);
  for (const o of logged) assert.ok(Number(o.usdMicro || 0) <= nav * 0.25, "no logged order may exceed 25% of NAV");
});

test("agent loop: auditor PASSES a conservative LLM plan and it executes", async () => {
  const db = freshDb();
  setPosition(db, "rtsla", 10_000_000n, 359_770_000n);
  setCash(db, 8_000_000_000n);                          // free cash → a $500 nibble is affordable
  const gentle = {
    mode: "live", model: "test-model", provider: "test",
    decide: async () => ({ trigger: "rebalance", rationale: "small nibble", orders: [{ action: "BUY", key: "rspy", usdMicro: 500_000_000 }] }),
    review: reviewStub,
  };
  await runSweep(db, { execMode: "paper", llm: gentle });
  const dec = listDecisions(db, 1)[0];
  const logged = JSON.parse(dec.orders_json || "[]");
  assert.equal(dec.review_verdict, "pass", `reason=${dec.review_rationale}`);
  assert.ok(logged.some((o) => o.action === "BUY" && o.key === "rspy"), "approved order should execute");
});
