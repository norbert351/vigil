// VIGIL — SQLite ledger (node:sqlite, zero-dep). WAL-safe single process.
// Persists: positions (+ cost basis), cash, realized P&L, the signed decision/manifest
// log with the context the agent saw, an equity-curve time series, price snapshots,
// and agent state. The decision log + equity curve are the auditable evidence the
// Agentic Trading track's "decision explainability + paper-trading log" judged on.
import { DatabaseSync } from "node:sqlite";

export function openDB(dbPath) {
  const db = new DatabaseSync(dbPath || process.env.VIGIL_DB_PATH || "./vigil.sqlite");
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS positions (
      key TEXT PRIMARY KEY,
      qty_micro INTEGER NOT NULL DEFAULT 0,
      avg_cost_micro INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nav_micro INTEGER,
      equity_micro INTEGER,
      cash_micro INTEGER DEFAULT 0,
      realized_pnl_micro INTEGER DEFAULT 0,
      status TEXT,
      last_run_ts INTEGER,
      nonce INTEGER DEFAULT 0,
      drawdown REAL,
      breaker_tripped INTEGER DEFAULT 0,
      kill_switched INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      window TEXT,            -- 'night' | 'day'  (the 'hours humans sleep')
      hash TEXT,
      sentinel TEXT,          -- VIGIL-<sha256>
      trigger TEXT,           -- macro/news/move/risk/hedge/rebalance
      model TEXT,
      llm TEXT,               -- qwen | stub
      nav_micro INTEGER,
      rationale TEXT,
      context_json TEXT,      -- snapshot of what the agent SAW (event → decision traceability)
      orders_json TEXT,
      mode TEXT,              -- paper | bitget
      review_verdict TEXT,    -- 'pass' | 'reject' | null (two-model audit)
      review_rationale TEXT   -- reviewer model's reasoning
    );
    CREATE TABLE IF NOT EXISTS orders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_seq INTEGER,
      action TEXT,            -- BUY | SELL | HEDGE | LIQUIDATE | HOLD
      key TEXT,
      qty_micro INTEGER,
      usd_micro INTEGER,
      px_micro INTEGER,
      pnl_micro INTEGER,      -- realized P&L on a SELL (0 for holds)
      fee_micro INTEGER,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS equity_curve (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      nav_micro INTEGER,
      cash_micro INTEGER
    );
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      json TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      type TEXT,
      severity TEXT,
      title TEXT,
      body TEXT,
      meta TEXT,
      delivered INTEGER DEFAULT 0
    );
  `);
  migrate(db);
  return db;
}

// Lightweight column/table migration so an existing dev DB picks up new fields.
function migrate(db) {
  const has = (tbl, col) => db.prepare(`PRAGMA table_info(${tbl})`).all().some((c) => c.name === col);
  if (!has("agent_state", "cash_micro")) db.exec("ALTER TABLE agent_state ADD COLUMN cash_micro INTEGER DEFAULT 0");
  if (!has("agent_state", "realized_pnl_micro")) db.exec("ALTER TABLE agent_state ADD COLUMN realized_pnl_micro INTEGER DEFAULT 0");
  if (!has("agent_state", "kill_switched")) db.exec("ALTER TABLE agent_state ADD COLUMN kill_switched INTEGER DEFAULT 0");
  if (!has("decisions", "context_json")) db.exec("ALTER TABLE decisions ADD COLUMN context_json TEXT");
  if (!has("decisions", "review_verdict")) db.exec("ALTER TABLE decisions ADD COLUMN review_verdict TEXT");
  if (!has("decisions", "review_rationale")) db.exec("ALTER TABLE decisions ADD COLUMN review_rationale TEXT");
  if (!has("orders", "pnl_micro")) db.exec("ALTER TABLE orders ADD COLUMN pnl_micro INTEGER DEFAULT 0");
  if (!has("orders", "fee_micro")) db.exec("ALTER TABLE orders ADD COLUMN fee_micro INTEGER DEFAULT 0");
}

// ---- positions (+ cost basis in micro-USD per 1e6 micro-units) ----
export function getPositions(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, qty_micro, avg_cost_micro FROM positions").all()) {
    out[r.key] = { qty: BigInt(r.qty_micro), avgCost: r.avg_cost_micro != null ? BigInt(r.avg_cost_micro) : null };
  }
  return out;
}
export function setPosition(db, key, qty, avgCost = null) {
  db.prepare(
    "INSERT INTO positions (key, qty_micro, avg_cost_micro) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET qty_micro = excluded.qty_micro, avg_cost_micro = COALESCE(excluded.avg_cost_micro, positions.avg_cost_micro)"
  ).run(key, qty.toString(), avgCost != null ? avgCost.toString() : null);
}
export function clearPositions(db) { db.prepare("DELETE FROM positions").run(); }

// flat qty map for valuation (fast path)
export function flatPositions(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, qty_micro FROM positions").all()) out[r.key] = BigInt(r.qty_micro);
  return out;
}

// ---- cash & realized P&L ----
export function getCash(db) { const r = db.prepare("SELECT cash_micro FROM agent_state WHERE id=1").get(); return BigInt(r?.cash_micro ?? 0); }
export function setCash(db, cash) {
  db.prepare("INSERT INTO agent_state (id, cash_micro, status) VALUES (1,?, 'init') ON CONFLICT(id) DO UPDATE SET cash_micro=excluded.cash_micro").run(cash.toString());
}
export function getRealized(db) { const r = db.prepare("SELECT realized_pnl_micro FROM agent_state WHERE id=1").get(); return BigInt(r?.realized_pnl_micro ?? 0); }
export function addRealized(db, delta) { db.prepare("INSERT INTO agent_state (id, realized_pnl_micro, status) VALUES (1,?, 'init') ON CONFLICT(id) DO UPDATE SET realized_pnl_micro = COALESCE((SELECT realized_pnl_micro FROM agent_state WHERE id=1),0) + excluded.realized_pnl_micro").run(delta.toString()); }

// ---- agent state ----
export function getAgentState(db) {
  const r = db.prepare("SELECT * FROM agent_state WHERE id=1").get();
  return r || { nav_micro: 0, equity_micro: 0, cash_micro: 0, realized_pnl_micro: 0, status: "init", last_run_ts: null, nonce: 0, drawdown: 0, breaker_tripped: 0, kill_switched: 0 };
}
export function setAgentState(db, patch) {
  const cur = getAgentState(db);
  const next = { ...cur, ...patch };
  db.prepare(
    "INSERT INTO agent_state (id, nav_micro, equity_micro, cash_micro, realized_pnl_micro, status, last_run_ts, nonce, drawdown, breaker_tripped, kill_switched) VALUES (1,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET nav_micro=excluded.nav_micro, equity_micro=excluded.equity_micro, cash_micro=excluded.cash_micro, realized_pnl_micro=excluded.realized_pnl_micro, status=excluded.status, last_run_ts=excluded.last_run_ts, nonce=excluded.nonce, drawdown=excluded.drawdown, breaker_tripped=excluded.breaker_tripped, kill_switched=excluded.kill_switched"
  ).run(
    String(next.nav_micro ?? 0), String(next.equity_micro ?? 0), String(next.cash_micro ?? 0), String(next.realized_pnl_micro ?? 0),
    String(next.status ?? "init"), next.last_run_ts ?? Date.now(), next.nonce ?? 0, next.drawdown ?? 0, next.breaker_tripped ? 1 : 0, next.kill_switched ? 1 : 0
  );
}

// ---- equity curve (the NAV time series for Sharpe/max-DD) ----
export function logEquity(db, ts, nav, cash) {
  db.prepare("INSERT INTO equity_curve (ts, nav_micro, cash_micro) VALUES (?,?,?)").run(ts, nav.toString(), cash.toString());
}
export function equityCurve(db, limit = 5000) {
  return db.prepare("SELECT ts, nav_micro, cash_micro FROM equity_curve ORDER BY id ASC LIMIT ?").all(limit);
}

// ---- decision log ----
export function logDecision(db, d) {
  const rep = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  const info = db.prepare(
    "INSERT INTO decisions (ts, window, hash, sentinel, trigger, model, llm, nav_micro, rationale, context_json, orders_json, mode, review_verdict, review_rationale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    d.ts, d.window, d.hash, d.sentinel, d.trigger, d.model || "", d.llm || "",
    String(d.navMicro || 0), d.rationale || "", d.context ? JSON.stringify(d.context, rep) : null, JSON.stringify(d.orders || [], rep), d.mode || "paper",
    d.reviewVerdict || null, d.reviewRationale || null
  );
  const decisionSeq = Number(info.lastInsertRowid);
  for (const o of d.orders || []) {
    db.prepare(
      "INSERT INTO orders (decision_seq, action, key, qty_micro, usd_micro, px_micro, pnl_micro, fee_micro, detail) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(decisionSeq, o.action, o.key, String(o.qtyMicro || 0), String(o.usdMicro || 0), String(o.pxMicro || 0), String(o.pnlMicro || 0), String(o.feeMicro || 0), o.detail || "");
  }
  return decisionSeq;
}
export function listDecisions(db, limit = 100) {
  return db.prepare("SELECT * FROM decisions ORDER BY seq DESC LIMIT ?").all(limit);
}
export function countDecisions(db) { const r = db.prepare("SELECT COUNT(*) c FROM decisions").get(); return Number(r.c); }
export function tradeRows(db) {
  return db.prepare("SELECT * FROM orders WHERE action IN ('BUY','SELL','HEDGE','LIQUIDATE') AND qty_micro > 0 ORDER BY seq ASC").all();
}
export function decisionLogCsv(db, sinceTs = 0) {
  const rows = db.prepare(
    "SELECT d.seq, d.ts, d.window, d.trigger, d.llm, d.nav_micro, d.rationale, " +
    "COALESCE(d.review_verdict,'') AS review_verdict, COALESCE(d.review_rationale,'') AS review_rationale, " +
    "COALESCE(d.context_json, '') AS context_json, " +
    "(SELECT json_group_array(json_object('action',o.action,'key',o.key,'usd',o.usd_micro,'px',o.px_micro,'pnl',o.pnl_micro,'fee',o.fee_micro)) FROM orders o WHERE o.decision_seq=d.seq) AS orders " +
    "FROM decisions d WHERE d.ts >= ? ORDER BY d.seq ASC"
  ).all(sinceTs);
  return rows;
}

// ---- kill switch ----
export function setKill(db, on) { db.prepare("INSERT INTO agent_state (id, kill_switched, status) VALUES (1,?, 'init') ON CONFLICT(id) DO UPDATE SET kill_switched=excluded.kill_switched").run(on ? 1 : 0); }
export function isKilled(db) { const r = db.prepare("SELECT kill_switched FROM agent_state WHERE id=1").get(); return Number(r?.kill_switched || 0) === 1; }

// ---- snapshots ----
export function saveSnapshot(db, json) { db.prepare("INSERT INTO price_snapshots (ts, json) VALUES (?, ?)").run(Date.now(), json); }

// ---- alerts (break-glass notifications) ----
export function logAlert(db, a) {
  db.prepare("INSERT INTO alerts (ts, type, severity, title, body, meta, delivered) VALUES (?,?,?,?,?,?,?)")
    .run(a.ts, a.type, a.severity, a.title, a.body, a.meta || null, a.delivered ? 1 : 0);
}
export function alertRows(db, limit = 50) {
  return db.prepare("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?").all(limit);
}
export function recentAlert(db, type) {
  return db.prepare("SELECT * FROM alerts WHERE type = ? ORDER BY ts DESC LIMIT 1").get(type);
}