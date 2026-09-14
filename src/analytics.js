// VIGIL — performance analytics from the equity curve + trade log.
// Supplies the Agentic Trading quant half: Sharpe, max drawdown, win rate, realized P&L.
// Pure functions over DB rows so they are unit-testable.
import { equityCurve, tradeRows, getAgentState } from "./db.js";

// Annualized Sharpe from the NAV time series (5-min observations treated as daily-equiv
// sampling is not right; we annualize by sqrt(365*288)-ish for intraday, but report a
// conservative daily-inferred Sharpe: sharper's definition uses per-period returns and
// sqrt(number of periods/year). We use 288 obs/day for a 5-min loop → 105,120/year.
export function sharpeFromCurve(rows, periodsPerYear = 105_120) {
  if (!rows || rows.length < 3) return null;
  const navs = rows.map((r) => Number(r.nav_micro));
  const returns = [];
  for (let i = 1; i < navs.length; i++) {
    const prev = navs[i - 1], cur = navs[i];
    if (prev > 0) returns.push(cur / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  // annualized: mean_per_period * periodsPerYear / (sd * sqrt(periodsPerYear))
  return (mean * periodsPerYear) / (sd * Math.sqrt(periodsPerYear));
}

// Max drawdown (fraction, 0..?) from peak-to-trough on the NAV curve.
export function maxDrawdown(rows) {
  if (!rows || rows.length < 2) return 0;
  let peak = 0, maxDD = 0;
  for (const r of rows) {
    const nav = Number(r.nav_micro);
    if (nav > peak) peak = nav;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - nav) / peak);
  }
  return maxDD;
}

// Win rate from realized P&L on closed SELL orders.
export function winRateAndPnl(rows = []) {
  if (!rows.length) return { trades: 0, wins: 0, winRate: null, realizedUsd: 0 };
  let wins = 0, realized = 0n;
  for (const r of rows) {
    const pnl = BigInt(r.pnl_micro || 0);
    if (pnl > 0n) wins++;
    realized += pnl;
  }
  return { trades: rows.length, wins, winRate: rows.length ? wins / rows.length : null, realizedUsd: Number(realized) / 1e6 };
}

// Aggregate metrics endpoint payload. Sharpe is computed on DAILY-resampled NAV (last
// observation per UTC day) so it is a sane, defensible annualized figure rather than an
// artifact of intraday sampling frequency. Needs >= 3 daily points to report.
export function computeMetrics(db) {
  const curve = equityCurve(db);
  const trades = tradeRows(db).filter((r) => r.action === "SELL"); // realized closes
  const wr = winRateAndPnl(trades);
  const daily = dailyNav(curve);
  return {
    observations: curve.length,
    dailyObservations: daily.length,
    sharpe: sharpeFromCurve(daily, 365),      // daily returns → annualize by sqrt(365)
    maxDrawdown: maxDrawdown(curve),
    dailyMaxDrawdown: maxDrawdown(daily),
    trades: wr.trades,
    winRate: wr.winRate,
    realizedPnlUsd: wr.realizedUsd,
    agent: getAgentState(db),
  };
}

// Collapse an intraday equity curve to daily NAV (last obs per UTC day).
export function dailyNav(curve) {
  const byDay = new Map();
  for (const r of curve) {
    byDay.set(new Date(Number(r.ts)).toISOString().slice(0, 10), r); // later entries overwrite → last of day
  }
  return [...byDay.values()];
}