// VIGIL — event-aligned night timeline.
// Merges what the agent SAW (headlines / macro from each decision's bound context),
// what it DID (decisions + trades), and how the book MOVED (NAV curve) onto a single
// time axis — so a judge can see event → decision causality at a glance.
import { listDecisions, equityCurve, alertRows } from "./db.js";

function usd(micro) { return Number(BigInt(micro || 0)) / 1e6; }

export function buildTimeline(db, { hours = 24 } = {}) {
  const since = Date.now() - hours * 3600_000;
  const events = [];

  let decisions = [];
  try { decisions = listDecisions(db, 500).filter((d) => d.ts >= since).reverse(); } catch { /* fresh */ }

  for (const d of decisions) {
    let orders = [];
    try { orders = JSON.parse(d.orders_json || "[]") || []; } catch { /* ignore */ }
    events.push({
      ts: Number(d.ts), kind: "decision", trigger: d.trigger, window: d.window,
      rationale: d.rationale || "", nav: usd(d.nav_micro),
      verdict: d.review_verdict || null, verdictReason: d.review_rationale || null,
      trades: orders.filter((o) => o.action && o.action !== "HOLD").map((o) => ({ action: o.action, key: o.key })),
      sentinel: d.sentinel || null,
    });
    // headlines the agent had in front of it at this moment (bound context)
    let ctx = null;
    try { ctx = d.context_json ? JSON.parse(d.context_json) : null; } catch { /* ignore */ }
    for (const n of (ctx?.news || []).slice(0, 3)) {
      if (!n) continue;
      events.push({ ts: Number(d.ts), kind: "news", title: typeof n === "string" ? n : (n.title || ""), severity: "info" });
    }
    const fng = ctx?.fearGreed && typeof ctx.fearGreed === "object" ? ctx.fearGreed.value : ctx?.fearGreed;
    if (fng != null) {
      const label = ctx?.fearGreed && typeof ctx.fearGreed === "object" ? ctx.fearGreed.label : null;
      events.push({ ts: Number(d.ts), kind: "macro", title: `Fear & Greed ${fng}${label ? " · " + label : ""}`, severity: "info" });
    }
  }

  try {
    for (const a of alertRows(db, 100)) {
      if (Number(a.ts) < since) continue;
      events.push({ ts: Number(a.ts), kind: "alert", title: a.title, body: a.body, severity: a.severity });
    }
  } catch { /* no alerts table yet */ }

  let navCurve = [];
  try {
    // drop pre-funding zero observations — a 0 at the head of the curve renders
    // as a cliff and makes the window's change% meaningless
    navCurve = equityCurve(db, 2000)
      .filter((r) => Number(r.ts) >= since && Number(r.nav_micro) > 0)
      .map((r) => ({ ts: Number(r.ts), nav: usd(r.nav_micro) }));
  } catch { /* fresh */ }

  events.sort((a, b) => a.ts - b.ts);
  const startNav = navCurve.length ? navCurve[0].nav : null;
  const endNav = navCurve.length ? navCurve[navCurve.length - 1].nav : null;
  return {
    hours, generatedAt: Date.now(),
    events, navCurve,
    navStart: startNav, navEnd: endNav,
    changePct: startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0,
    counts: {
      decisions: events.filter((e) => e.kind === "decision").length,
      news: events.filter((e) => e.kind === "news").length,
      alerts: events.filter((e) => e.kind === "alert").length,
      trades: events.reduce((n, e) => n + (e.trades ? e.trades.length : 0), 0),
      rejected: decisions.filter((d) => d.review_verdict === "reject").length,
    },
  };
}