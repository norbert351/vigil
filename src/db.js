// VIGIL — ledger layer dispatcher.
// sqlite mode (default): the original zero-dep node:sqlite ledger (sync) — used by the
// test suite and any local/vm run without VIGIL_DATABASE_URL.
// pg mode (when VIGIL_DATABASE_URL set): async Postgres on Neon, schema-qualified.
// The exported function set is identical so consumers can `await` every call safely in
// both modes (`await` on a sync value is a no-op).
export const DB_MODE = process.env.VIGIL_DATABASE_URL ? "pg" : "sqlite";
const impl = DB_MODE === "pg" ? (await import("./db-pg.js")) : (await import("./db-sqlite.js"));

export const {
  openDB, getPositions, setPosition, clearPositions, flatPositions,
  getCash, setCash, getRealized, addRealized,
  getAgentState, setAgentState, logEquity, equityCurve,
  logDecision, listDecisions, countDecisions, tradeRows, decisionLogCsv,
  setKill, isKilled, saveSnapshot, logAlert, alertRows, recentAlert,
} = impl;

export const ensureSchema = impl.ensureSchema || (async () => {});
export const _q = impl.q || null;