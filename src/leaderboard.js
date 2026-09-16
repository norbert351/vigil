// VIGIL — session leaderboard.
// Ranks every connected book (flagship + user sessions) by performance so the
// multi-session flow becomes a visible, competitive community surface.
import { computeMetrics } from "./analytics.js";
import { getAgentState, countDecisions, equityCurve, flatPositions, getCash } from "./db.js";
import { listSessions, sessionDb } from "./sessions.js";
import { portfolioState } from "./engine.js";

function usd(micro) { return Number(BigInt(micro || 0)) / 1e6; }

// Score one book from its ledger (works for the flagship db or any session db).
export function scoreBook(db, meta) {
  let nav = 0, cash = 0, holdings = 0, startNav = 0;
  try {
    // portfolioState expects a flat {key: qtyBigInt} map (not getPositions' {key:{qty}})
    const pos = flatPositions(db);
    const prices = meta.prices || {};
    const st = portfolioState(pos, prices);
    cash = usd(getCash(db));
    nav = usd(st.total) + cash;
    holdings = Object.values(pos).filter((q) => q > 0n).length;
  } catch { /* fresh book */ }
  try {
    // the book's TRUE starting NAV = first NON-ZERO equity observation
    // (a pre-funding sweep can legitimately log nav 0, which must not skew return)
    const curve = equityCurve(db, 5000).filter((r) => Number(r.nav_micro) > 0);
    if (curve.length) startNav = usd(curve[0].nav_micro);
  } catch { /* fresh */ }
  if (!startNav || startNav <= 0) startNav = nav || 0;
  let m = {};
  try { m = computeMetrics(db) || {}; } catch { /* no curve yet */ }
  let ag = {};
  try { ag = getAgentState(db) || {}; } catch { /* fresh */ }
  let decisions = 0;
  try { decisions = countDecisions(db); } catch { /* fresh */ }
  const retPct = startNav > 0 ? ((nav - startNav) / startNav) * 100 : 0;
  return {
    id: meta.id || "flagship",
    name: meta.name || "VIGIL flagship",
    kind: meta.kind || "flagship",
    nav, cash, holdings, decisions, startNav,
    returnPct: retPct,
    sharpe: m.sharpe ?? null,
    maxDrawdown: m.maxDrawdown ?? null,
    winRate: m.winRate ?? null,
    trades: m.trades ?? 0,
    realizedPnl: m.realizedPnlUsd ?? 0,
    status: ag.status || "—",
    createdAt: meta.createdAt || null,
  };
}

// Rank: return first, then Sharpe (nulls last), then decision density.
export function rankBooks(books) {
  return [...books].sort((a, b) => {
    if (b.returnPct !== a.returnPct) return b.returnPct - a.returnPct;
    const sa = a.sharpe ?? -Infinity, sb = b.sharpe ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return b.decisions - a.decisions;
  }).map((b, i) => ({ ...b, rank: i + 1 }));
}

export function buildLeaderboard(flagshipDb, { prices = {} } = {}) {
  const books = [];
  try { books.push(scoreBook(flagshipDb, { id: "flagship", name: "VIGIL flagship (venue demo)", kind: "flagship", prices })); } catch { /* skip */ }
  for (const s of listSessions()) {
    try { books.push(scoreBook(sessionDb(s.id), { id: s.id, name: s.name, kind: "session", createdAt: s.createdAt, prices })); } catch { /* skip broken session */ }
  }
  return rankBooks(books);
}