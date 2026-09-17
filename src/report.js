// VIGIL — overnight "sleep report" generator.
// Produces a dated digest: what happened overnight, what the agent did, NAV move
// vs a do-nothing baseline, and (when a live LLM is wired) a plain-language
// narration of the night. Served at /reports/latest and exportable to docs/.
import { getPositions, getCash, listDecisions, equityCurve, getAgentState } from "./db.js";
import { portfolioState } from "./engine.js";
import { refreshPrices } from "./market.js";
import { llmFactory } from "./llm.js";

function usd(micro) { return Number(BigInt(micro || 0)) / 1e6; }
function fmtUsd(n) { return "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function fmtTs(ts) { return new Date(Number(ts)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

// Collect the night's facts from the ledger (no LLM needed).
export function nightFacts(db, { sinceTs = 0 } = {}) {
  const decisions = listDecisions(db, 500).reverse().filter((d) => d.ts >= sinceTs);
  const trades = decisions.flatMap((d) => (JSON.parse(d.orders_json || "[]") || []).filter((o) => o.action && o.action !== "HOLD"));
  const curve = equityCurve(db, 2000).filter((r) => r.ts >= sinceTs && Number(r.nav_micro) > 0);
  const ag = getAgentState(db);
  const startNav = curve.length ? usd(curve[0].nav_micro) : (ag.nav_micro ? usd(ag.nav_micro) : 0);
  const endNav = curve.length ? usd(curve[curve.length - 1].nav_micro) : startNav;
  const baselineMove = 0; // requires price rehydration; reported when available
  return {
    decisions, trades,
    navStart: startNav, navEnd: endNav,
    navChange: endNav - startNav,
    navChangePct: startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0,
    tradeCount: trades.length,
    sellCount: trades.filter((t) => t.action === "SELL").length,
    buyCount: trades.filter((t) => t.action === "BUY").length,
    breakerTripped: Number(ag.breaker_tripped || 0) === 1,
    killed: Number(ag.kill_switched || 0) === 1,
    decisionCount: decisions.length,
    topTriggers: Object.entries(decisions.reduce((a, d) => { a[d.trigger] = (a[d.trigger] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}

// LLM narration when a live key exists; deterministic summary otherwise.
async function narrate(facts, llm) {
  const summary = [
    `Over ${facts.decisionCount} decision cycles, the agent made ${facts.tradeCount} trades (${facts.buyCount} buys / ${facts.sellCount} sells),`,
    `moving NAV from ${fmtUsd(facts.navStart)} to ${fmtUsd(facts.navEnd)} (${facts.navChangePct.toFixed(2)}%).`,
    `Dominant triggers: ${facts.topTriggers.map(([k, v]) => `${k}×${v}`).join(", ") || "none"}.`,
  ].join(" ");

  if (llm && llm.mode !== "stub") {
    try {
      // Resolve the live endpoint from the SAME seam as the decision-maker so the
      // narration follows the configured model (Qwen sponsor / any OpenAI-compatible).
      // Do NOT hard-code a Gemini URL: under VIGIL_LLM=qwen the key is VIGIL_QWEN_API_KEY.
      const { baseUrl, model, key } = llmProvider();
      if (baseUrl && model && key) {
        const body = JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You narrate an autonomous trading agent's overnight report in 3-4 plain, confident sentences. No jargon, no disclaimers, no bullet points." },
            { role: "user", content: `Overnight facts: ${summary}\n\nWrite the 'night in plain language' paragraph.` },
          ],
          temperature: 0.4,
          max_tokens: 400,
        });
        const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body, signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const j = await res.json();
          const text = (j?.choices?.[0]?.message?.content || "").trim();
          if (text) return { narration: text, model: `${model} (narration)` };
        }
      }
    } catch { /* fall through to deterministic */ }
  }
  return { narration: summary, model: "deterministic" };
}

// Resolve base URL / model / API key for the current LLM mode (mirror of llm.js factory).
function llmProvider() {
  const mode = String(LLM_MODE() || "stub").toLowerCase();
  if (mode === "qwen") {
    return {
      baseUrl: process.env.VIGIL_QWEN_BASE || "https://hackathon.bitgetops.com/v1",
      model: process.env.VIGIL_QWEN_MODEL || "qwen3.8-max",
      key: process.env.VIGIL_QWEN_API_KEY || "",
    };
  }
  // live / any OpenAI-compatible endpoint
  return {
    baseUrl: process.env.VIGIL_LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.VIGIL_LLM_MODEL || "qwen3.8-max",
    key: process.env.VIGIL_LLM_API_KEY || "",
  };
}
function LLM_MODE() { return process.env.VIGIL_LLM || "stub"; }

// Full report (JSON facts + narration). Facts are always exact from the ledger.
export async function buildReport(db, opts = {}) {
  const sinceTs = opts.sinceTs || (Date.now() - 24 * 3600_000);
  const facts = nightFacts(db, { sinceTs });
  const llm = llmFactory();
  const { narration, model } = await narrate(facts, llm);
  return { generatedAt: Date.now(), windowHours: 24, facts, narration, model };
}

const el = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderReportHtml(r, { title = "Overnight report" } = {}) {
  const f = r.facts;
  const rows = f.decisions.slice(-8).reverse().map((d) => `
    <tr><td class="mono">${el(fmtTs(d.ts))}</td><td>${el(d.trigger)}</td><td><span class="pill ${d.review_verdict === "reject" ? "bad" : d.review_verdict ? "good" : ""}">${d.review_verdict ? (d.review_verdict === "reject" ? "✗ rejected" : "✓ passed") : "—"}</span></td><td class="mono">${el(fmtUsd(usd(d.nav_micro)))}</td><td>${el(String(d.rationale || "").slice(0, 140))}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No decisions in this window.</td></tr>';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${el(title)} · VIGIL</title>
<link rel="preconnect" href="https://api.fontshare.com"/><link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@500,600,700,800&f[]=general-sans@400,500,600,700&display=swap"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap"/>
<style>
:root{--bg:#070F1D;--pane:#0B1B33;--line:rgba(160,190,230,.16);--brand:#4FA3FF;--brand2:#6FD3FF;--txt:#D7E4F5;--mut:#8FA9CB;--up:#3DD68C;--down:#FF6B6B;--disp:'Cabinet Grotesk',sans-serif;--body:'General Sans',sans-serif;--mono:'JetBrains Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--txt);font:15px/1.6 var(--body);-webkit-font-smoothing:antialiased}.wrap{width:min(900px,92%);margin:0 auto;padding:40px 0 80px}
.eyebrow{font:600 12px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--brand2);margin-bottom:14px}
h1{font:700 clamp(30px,4.5vw,44px)/1.1 var(--disp);color:#fff;letter-spacing:-.015em;margin-bottom:8px}
.sub{color:var(--mut);font-size:14px;margin-bottom:34px}
.narr{border:1px solid var(--line);border-radius:18px;background:var(--pane);padding:28px;margin-bottom:34px;font-size:16.5px;color:#E6F0FF;line-height:1.75}
.narr .who{display:block;font:11px var(--mono);color:var(--brand2);letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:34px}
.s{border:1px solid var(--line);border-radius:14px;background:var(--pane);padding:18px}
.s .num{font:700 24px var(--disp);color:#fff}.s .num.up{color:var(--up)}.s .num.down{color:var(--down)}
.s .lab{font:10.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mut);padding:8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px solid rgba(160,190,230,.08);vertical-align:top}.mono{font-family:var(--mono)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font:600 10.5px var(--mono);border:1px solid var(--line)}
.pill.good{background:rgba(61,214,140,.12);border-color:rgba(61,214,140,.35);color:#9BE8C4}.pill.bad{background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.4);color:#FFB4B4}
.empty{padding:18px;text-align:center;color:var(--mut)}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<div class="eyebrow">VIGIL · ${el(f.windowHours)}h report</div>
<h1>While you slept</h1>
<div class="sub">${el(fmtTs(r.generatedAt - 24 * 3600_000))} → ${el(fmtTs(r.generatedAt))} · ${f.decisionCount} decision cycles · ${f.tradeCount} trades ${f.breakerTripped ? "· ⚠ breaker tripped" : ""}</div>
<div class="narr"><span class="who">Narrated by ${el(r.model)}</span>${el(r.narration)}</div>
<div class="stats">
  <div class="s"><div class="num ${f.navChange >= 0 ? "up" : "down"}">${el(fmtUsd(f.navEnd))}</div><div class="lab">NAV now</div></div>
  <div class="s"><div class="num ${f.navChange >= 0 ? "up" : "down"}">${(f.navChangePct >= 0 ? "+" : "") + f.navChangePct.toFixed(2)}%</div><div class="lab">Night change</div></div>
  <div class="s"><div class="num">${f.tradeCount}</div><div class="lab">Trades</div></div>
  <div class="s"><div class="num">${f.topTriggers.length ? el(f.topTriggers[0][0]) : "—"}</div><div class="lab">Top trigger</div></div>
</div>
<table><thead><tr><th>Time</th><th>Trigger</th><th>Audit</th><th>NAV</th><th>Rationale</th></tr></thead><tbody>${rows}</tbody></table>
</div></body></html>`;
}