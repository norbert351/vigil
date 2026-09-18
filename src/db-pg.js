// VIGIL — async Postgres (Neon) implementation of the ledger layer.
// Active when VIGIL_DATABASE_URL is set. `db` is a SCHEMA TAG (string), not a handle:
// the flagship uses schema `vigil`; each Connect session gets its own
// `vigil_session_<id>` schema, so books stay isolated like their sqlite files.
// Every query is schema-qualified (`${db}.<table>`) — REQUIRED because Neon's
// transaction-mode pooler does not persist session-level search_path.
import pg from "pg";
const { Pool } = pg;

const URL = process.env.VIGIL_DATABASE_URL || "";
const CLEAN = URL.split("?")[0]; // drop sslmode/channel_binding; SSL set on the Pool
let POOL = null;
function pool() {
  if (!POOL) POOL = new Pool({
    connectionString: CLEAN, ssl: { rejectUnauthorized: false },
    max: 8, statement_timeout: 30000, query_timeout: 30000, idleTimeoutMillis: 30000,
  });
  return POOL;
}

export async function ensureSchema(schema) {
  const p = pool();
  const s = (t) => `${schema}.${t}`;
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("positions")} (key TEXT PRIMARY KEY, qty_micro BIGINT NOT NULL DEFAULT 0, avg_cost_micro BIGINT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("agent_state")} (id SMALLINT PRIMARY KEY, nav_micro BIGINT, equity_micro BIGINT, cash_micro BIGINT DEFAULT 0, realized_pnl_micro BIGINT DEFAULT 0, status TEXT, last_run_ts BIGINT, nonce BIGINT DEFAULT 0, drawdown DOUBLE PRECISION, breaker_tripped SMALLINT DEFAULT 0, kill_switched SMALLINT DEFAULT 0)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("decisions")} (seq BIGSERIAL PRIMARY KEY, ts BIGINT, "window" TEXT, hash TEXT, sentinel TEXT, trigger TEXT, model TEXT, llm TEXT, nav_micro BIGINT, rationale TEXT, context_json TEXT, orders_json TEXT, mode TEXT, review_verdict TEXT, review_rationale TEXT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("orders")} (seq BIGSERIAL PRIMARY KEY, decision_seq BIGINT, action TEXT, key TEXT, qty_micro BIGINT, usd_micro BIGINT, px_micro BIGINT, pnl_micro BIGINT, fee_micro BIGINT, detail TEXT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("equity_curve")} (id BIGSERIAL PRIMARY KEY, ts BIGINT, nav_micro BIGINT, cash_micro BIGINT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("price_snapshots")} (id BIGSERIAL PRIMARY KEY, ts BIGINT, json TEXT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${s("alerts")} (id BIGSERIAL PRIMARY KEY, ts BIGINT, type TEXT, severity TEXT, title TEXT, body TEXT, meta TEXT, delivered SMALLINT DEFAULT 0)`);
}

// sync handle only: returns the schema tag (DDL is ensured lazily via ensureSchema off the boot path)
export function openDB(tag) { return tag || "vigil"; }

export const q = (db, table) => `${db}.${table}`;

// ---- positions ----
export async function getPositions(db) {
  const { rows } = await pool().query(`SELECT key, qty_micro, avg_cost_micro FROM ${q(db, "positions")}`);
  const out = {};
  for (const r of rows) out[r.key] = { qty: BigInt(r.qty_micro), avgCost: r.avg_cost_micro != null ? BigInt(r.avg_cost_micro) : null };
  return out;
}
export async function setPosition(db, key, qty, avgCost = null) {
  await pool().query(
    `INSERT INTO ${q(db, "positions")} (key, qty_micro, avg_cost_micro) VALUES ($1,$2,$3) ` +
    `ON CONFLICT(key) DO UPDATE SET qty_micro=EXCLUDED.qty_micro, avg_cost_micro=COALESCE(EXCLUDED.avg_cost_micro, ${q(db, "positions")}.avg_cost_micro)`,
    [key, qty.toString(), avgCost != null ? avgCost.toString() : null]
  );
}
export async function clearPositions(db) { await pool().query(`DELETE FROM ${q(db, "positions")}`); }
export async function flatPositions(db) {
  const { rows } = await pool().query(`SELECT key, qty_micro FROM ${q(db, "positions")}`);
  const out = {}; for (const r of rows) out[r.key] = BigInt(r.qty_micro); return out;
}

// ---- cash & realized P&L ----
export async function getCash(db) {
  const { rows } = await pool().query(`SELECT cash_micro FROM ${q(db, "agent_state")} WHERE id=1`);
  return BigInt(rows[0]?.cash_micro ?? 0);
}
export async function setCash(db, cash) {
  await pool().query(`INSERT INTO ${q(db, "agent_state")} (id, cash_micro, status) VALUES (1,$1,'init') ON CONFLICT(id) DO UPDATE SET cash_micro=EXCLUDED.cash_micro`, [cash.toString()]);
}
export async function getRealized(db) {
  const { rows } = await pool().query(`SELECT realized_pnl_micro FROM ${q(db, "agent_state")} WHERE id=1`);
  return BigInt(rows[0]?.realized_pnl_micro ?? 0);
}
export async function addRealized(db, delta) {
  await pool().query(
    `INSERT INTO ${q(db, "agent_state")} (id, realized_pnl_micro, status) VALUES (1,$1,'init') ` +
    `ON CONFLICT(id) DO UPDATE SET realized_pnl_micro = COALESCE(${q(db, "agent_state")}.realized_pnl_micro, 0) + EXCLUDED.realized_pnl_micro`,
    [delta.toString()]
  );
}

// ---- agent state ----
export async function getAgentState(db) {
  const { rows } = await pool().query(`SELECT * FROM ${q(db, "agent_state")} WHERE id=1`);
  return rows[0] || { nav_micro: 0, equity_micro: 0, cash_micro: 0, realized_pnl_micro: 0, status: "init", last_run_ts: null, nonce: 0, drawdown: 0, breaker_tripped: 0, kill_switched: 0 };
}
export async function setAgentState(db, patch) {
  const cur = await getAgentState(db);
  const next = { ...cur, ...patch };
  await pool().query(
    `INSERT INTO ${q(db, "agent_state")} (id, nav_micro, equity_micro, cash_micro, realized_pnl_micro, status, last_run_ts, nonce, drawdown, breaker_tripped, kill_switched) ` +
    `VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ` +
    `ON CONFLICT(id) DO UPDATE SET nav_micro=EXCLUDED.nav_micro, equity_micro=EXCLUDED.equity_micro, cash_micro=EXCLUDED.cash_micro, realized_pnl_micro=EXCLUDED.realized_pnl_micro, status=EXCLUDED.status, last_run_ts=EXCLUDED.last_run_ts, nonce=EXCLUDED.nonce, drawdown=EXCLUDED.drawdown, breaker_tripped=EXCLUDED.breaker_tripped, kill_switched=EXCLUDED.kill_switched`,
    [String(next.nav_micro ?? 0), String(next.equity_micro ?? 0), String(next.cash_micro ?? 0), String(next.realized_pnl_micro ?? 0),
     String(next.status ?? "init"), next.last_run_ts ?? Date.now(), String(next.nonce ?? 0), next.drawdown ?? 0, next.breaker_tripped ? 1 : 0, next.kill_switched ? 1 : 0]
  );
}

// ---- equity curve ----
export async function logEquity(db, ts, nav, cash) {
  await pool().query(`INSERT INTO ${q(db, "equity_curve")} (ts, nav_micro, cash_micro) VALUES ($1,$2,$3)`, [ts, nav.toString(), cash.toString()]);
}
export async function equityCurve(db, limit = 5000) {
  const { rows } = await pool().query(`SELECT ts, nav_micro, cash_micro FROM ${q(db, "equity_curve")} ORDER BY id ASC LIMIT $1`, [limit]);
  return rows;
}

// ---- decision log ----
export async function logDecision(db, d) {
  const rep = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  const { rows } = await pool().query(
    `INSERT INTO ${q(db, "decisions")} (ts, "window", hash, sentinel, trigger, model, llm, nav_micro, rationale, context_json, orders_json, mode, review_verdict, review_rationale) ` +
    `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING seq`,
    [d.ts, d.window, d.hash, d.sentinel, d.trigger, d.model || "", d.llm || "",
     String(d.navMicro || 0), d.rationale || "", d.context ? JSON.stringify(d.context, rep) : null, JSON.stringify(d.orders || [], rep), d.mode || "paper",
     d.reviewVerdict || null, d.reviewRationale || null]
  );
  const decisionSeq = Number(rows[0].seq);
  for (const o of d.orders || []) {
    await pool().query(
      `INSERT INTO ${q(db, "orders")} (decision_seq, action, key, qty_micro, usd_micro, px_micro, pnl_micro, fee_micro, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [decisionSeq, o.action, o.key, String(o.qtyMicro || 0), String(o.usdMicro || 0), String(o.pxMicro || 0), String(o.pnlMicro || 0), String(o.feeMicro || 0), o.detail || ""]
    );
  }
  return decisionSeq;
}
export async function listDecisions(db, limit = 100) {
  const { rows } = await pool().query(`SELECT * FROM ${q(db, "decisions")} ORDER BY seq DESC LIMIT $1`, [limit]);
  return rows;
}
export async function countDecisions(db) {
  const { rows } = await pool().query(`SELECT COUNT(*)::int AS c FROM ${q(db, "decisions")}`);
  return Number(rows[0].c);
}
export async function tradeRows(db) {
  const { rows } = await pool().query(`SELECT * FROM ${q(db, "orders")} WHERE action IN ('BUY','SELL','HEDGE','LIQUIDATE') AND qty_micro > 0 ORDER BY seq ASC`);
  return rows;
}
export async function decisionLogCsv(db, sinceTs = 0) {
  const { rows } = await pool().query(
    `SELECT d.seq, d.ts, d."window", d.trigger, d.llm, d.nav_micro, d.rationale, ` +
    `COALESCE(d.review_verdict,'') AS review_verdict, COALESCE(d.review_rationale,'') AS review_rationale, ` +
    `COALESCE(d.context_json, '') AS context_json, ` +
    `(SELECT COALESCE(json_agg(json_build_object('action',o.action,'key',o.key,'usd',o.usd_micro,'px',o.px_micro,'pnl',o.pnl_micro,'fee',o.fee_micro))::text, '[]') ` +
    `FROM ${q(db, "orders")} o WHERE o.decision_seq=d.seq) AS orders ` +
    `FROM ${q(db, "decisions")} d WHERE d.ts >= $1 ORDER BY d.seq ASC`,
    [sinceTs]
  );
  return rows;
}

// ---- kill switch ----
export async function setKill(db, on) {
  await pool().query(`INSERT INTO ${q(db, "agent_state")} (id, kill_switched, status) VALUES (1,$1,'init') ON CONFLICT(id) DO UPDATE SET kill_switched=EXCLUDED.kill_switched`, [on ? 1 : 0]);
}
export async function isKilled(db) {
  const { rows } = await pool().query(`SELECT kill_switched FROM ${q(db, "agent_state")} WHERE id=1`);
  return Number(rows[0]?.kill_switched || 0) === 1;
}

// ---- snapshots ----
export async function saveSnapshot(db, json) {
  await pool().query(`INSERT INTO ${q(db, "price_snapshots")} (ts, json) VALUES ($1,$2)`, [Date.now(), json]);
}

// ---- alerts ----
export async function logAlert(db, a) {
  await pool().query(`INSERT INTO ${q(db, "alerts")} (ts, type, severity, title, body, meta, delivered) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.ts, a.type, a.severity, a.title, a.body, a.meta || null, a.delivered ? 1 : 0]);
}
export async function alertRows(db, limit = 50) {
  const { rows } = await pool().query(`SELECT * FROM ${q(db, "alerts")} ORDER BY ts DESC LIMIT $1`, [limit]);
  return rows;
}
export async function recentAlert(db, type) {
  const { rows } = await pool().query(`SELECT * FROM ${q(db, "alerts")} WHERE type = $1 ORDER BY ts DESC LIMIT 1`, [type]);
  return rows[0] || null;
}