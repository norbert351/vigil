// VIGIL — SQLite ledger (node:sqlite, zero-dep). WAL-safe single process.
// Persists: positions, the signed decision/manifest log (= the paper-trading log),
// price snapshots, and agent state. The decision log is the auditable evidence the
// Agentic Trading track's "decision explainability + paper-trading log" judged on.
import { DatabaseSync } from "node:sqlite";

export function openDB() {
  const db = new DatabaseSync(process.env.VIGIL_DB_PATH || "./vigil.sqlite");
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
      status TEXT,
      last_run_ts INTEGER,
      nonce INTEGER DEFAULT 0,
      drawdown REAL,
      breaker_tripped INTEGER DEFAULT 0
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
      orders_json TEXT,
      mode TEXT               -- paper | bitget
    );
    CREATE TABLE IF NOT EXISTS orders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_seq INTEGER,
      action TEXT,            -- BUY | SELL | HEDGE | LIQUIDATE | HOLD
      key TEXT,
      qty_micro INTEGER,
      usd_micro INTEGER,
      px_micro INTEGER,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      json TEXT
    );
  `);
  return db;
}

// ---- positions ----
export function getPositions(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, qty_micro FROM positions").all()) {
    out[r.key] = BigInt(r.qty_micro);
  }
  return out;
}
export function setPosition(db, key, qty) {
  db.prepare(
    "INSERT INTO positions (key, qty_micro, avg_cost_micro) VALUES (?, ?, NULL) " +
    "ON CONFLICT(key) DO UPDATE SET qty_micro = excluded.qty_micro"
  ).run(key, qty.toString());
}
export function clearPositions(db) {
  db.prepare("DELETE FROM positions").run();
}

// ---- agent state ----
export function getAgentState(db) {
  const r = db.prepare("SELECT * FROM agent_state WHERE id=1").get();
  return r || { nav_micro: 0, equity_micro: 0, status: "init", last_run_ts: null, nonce: 0, drawdown: 0, breaker_tripped: 0 };
}
export function setAgentState(db, patch) {
  const cur = getAgentState(db);
  const next = { ...cur, ...patch };
  db.prepare(
    "INSERT INTO agent_state (id, nav_micro, equity_micro, status, last_run_ts, nonce, drawdown, breaker_tripped) VALUES (1,?,?,?,?,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET nav_micro=excluded.nav_micro, equity_micro=excluded.equity_micro, status=excluded.status, last_run_ts=excluded.last_run_ts, nonce=excluded.nonce, drawdown=excluded.drawdown, breaker_tripped=excluded.breaker_tripped"
  ).run(
    String(next.nav_micro ?? 0), String(next.equity_micro ?? 0), String(next.status ?? "init"),
    next.last_run_ts ?? Date.now(), next.nonce ?? 0, next.drawdown ?? 0, next.breaker_tripped ? 1 : 0
  );
}

// ---- decision log (the paper-trading log) ----
export function logDecision(db, d) {
  const rep = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  const info = db.prepare(
    "INSERT INTO decisions (ts, window, hash, sentinel, trigger, model, llm, nav_micro, rationale, orders_json, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    d.ts, d.window, d.hash, d.sentinel, d.trigger, d.model || "", d.llm || "",
    String(d.navMicro || 0), d.rationale || "", JSON.stringify(d.orders || [], rep), d.mode || "paper"
  );
  const decisionSeq = Number(info.lastInsertRowid);
  for (const o of d.orders || []) {
    db.prepare(
      "INSERT INTO orders (decision_seq, action, key, qty_micro, usd_micro, px_micro, detail) VALUES (?,?,?,?,?,?,?)"
    ).run(decisionSeq, o.action, o.key, String(o.qtyMicro || 0), String(o.usdMicro || 0), String(o.pxMicro || 0), o.detail || "");
  }
  return decisionSeq;
}
export function listDecisions(db, limit = 100) {
  return db.prepare("SELECT * FROM decisions ORDER BY seq DESC LIMIT ?").all(limit);
}
export function decisionLogCsv(db, sinceTs = 0) {
  const rows = db.prepare(
    "SELECT d.seq, d.ts, d.window, d.trigger, d.llm, d.nav_micro, d.rationale, " +
    "(SELECT json_group_array(json_object('action',o.action,'key',o.key,'usd',o.usd_micro,'px',o.px_micro)) FROM orders o WHERE o.decision_seq=d.seq) AS orders " +
    "FROM decisions d WHERE d.ts >= ? ORDER BY d.seq ASC"
  ).all(sinceTs);
  return rows;
}

// ---- snapshots ----
export function saveSnapshot(db, json) {
  db.prepare("INSERT INTO price_snapshots (ts, json) VALUES (?, ?)").run(Date.now(), json);
}

export function openLedgerRows(db) {
  const pos = getPositions(db);
  const rows = Object.entries(pos).map(([k, v]) => ({ key: k, qty: v.qty }));
  return rows;
}