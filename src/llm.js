// VIGIL — LLM decision seam.
// Decision-maker per the Agentic Trading thesis: the LLM IS the primary trading
// decision-maker (not an assistant). Two modes behind one interface:
//   qwen = Qwen (qwen3.8-max) via Bitget's hackathon endpoint (LLM_MODE=qwen)
//   stub = deterministic reasoning (no network; used in tests + as a safe fallback)
// The seam so the Qwen key can be swapped in without touching the loop. The stub ALSO
// implements the cross-asset regime rotation (Fear & Greed → risk-on/off) so the live
// paper log demonstrates the sub-theme's core behavior before Qwen is provisioned.
import { LLM_MODE, QWEN_BASE_URL, QWEN_MODEL, REGIME_FEAR, REGIME_GREED } from "./config.js";

function isDefensive(k) { return ["rspy", "rqqq", "raapl"].includes(k); }

function regimeOf(perception) {
  const fng = perception?.fearGreed?.value;
  if (fng == null) return { regime: "unknown", fng: null };
  if (Number(fng) < REGIME_FEAR) return { regime: "fear", fng: Number(fng) };
  if (Number(fng) > REGIME_GREED) return { regime: "greed", fng: Number(fng) };
  return { regime: "neutral", fng: Number(fng) };
}

// Deterministic stub: implements momentum-risk trims AND cross-asset regime rotation.
export async function decideStub(state) {
  const { regime, fng } = regimeOf(state.perception);
  const orders = [];
  let trigger;
  let rationale;

  if (state.breaker || state.killed) {
    trigger = state.breaker ? "risk" : "killed";
    rationale = state.breaker
      ? "Circuit breaker tripped: de-risking to defensive base for the night."
      : "Kill-switch armed: halted all trading.";
    return { trigger, rationale, orders }; // risk layer already handles liquidation/withhold
  }

  // CROSS-ASSET REGIME ROTATION (the sub-theme's core behavior)
  if (state.window === "night" && regime === "fear") {
    // risk-off overnight: trim crypto + a high-beta equity, buy defensive index base
    const trims = ["btc", "eth", "rtsla"].filter((k) => state.positions[k]);
    let budget = 0;
    for (const k of trims) {
      const p = state.positions[k];
      if (!p || !p.value || p.chg24 == null) continue;
      const sell = Math.min(Number(p.value), Math.round(state.nav * 0.05));
      if (sell > 0) { orders.push({ action: "SELL", key: k, usdMicro: sell, reason: "night-fear-rotation" }); budget += sell; }
    }
    const base = ["rspy", "rqqq"].find((k) => state.positions[k] || state.targets?.[k]);
    if (budget > 0 && base) orders.push({ action: "BUY", key: base, usdMicro: Math.round(budget / 2), reason: "night-fear-defensive" });
    trigger = "hedge";
    rationale = `Risk-off regime (Fear&Greed ${fng}) overnight: rotated high-beta crypto/equity into defensive index base; trimmed to hedge the human's absence.`;
    return { trigger, rationale, orders };
  }
  if (regime === "greed") {
    // risk-on: modest re-allocation toward the growth names already held
    let went = 0;
    for (const k of ["rnvda", "rtsla", "btc"]) {
      if (went >= 0.03 * state.nav) break;
      const p = state.positions[k];
      if (p && p.value && p.chg24 != null && p.chg24 < 0.02) {
        orders.push({ action: "BUY", key: k, usdMicro: Math.round(0.03 * state.nav), reason: "greed-tilt" });
        went += 0.03 * state.nav;
      }
    }
    trigger = orders.length ? "hedge" : "hold";
    rationale = orders.length ? `Risk-on regime (Fear&Greed ${fng}): small tilt into growth while drawdown is healthy.` : `Risk-on regime (Fear&Greed ${fng}) but no pullback to buy; holding.`;
    return { trigger, rationale, orders };
  }

  // neutral / daytime: defensive momentum-risk trimming (laggard trim, deep-value nibble)
  for (const [k, p] of Object.entries(state.positions)) {
    if (Number(p.qty || 0n) > 0 && p.chg24 != null && p.chg24 < -0.025 && !isDefensive(k)) {
      orders.push({ action: "SELL", key: k, usdMicro: Math.min(Number(p.value || 0), Math.round(state.nav * 0.05)), reason: "momentum-trim" });
    } else if (state.drawdown < 0.04 && Number(p.qty || 0n) >= 0 && p.chg24 != null && p.chg24 < -0.05 && isDefensive(k)) {
      orders.push({ action: "BUY", key: k, usdMicro: Math.round(state.nav * 0.03), reason: "deep-value" });
    }
  }
  return {
    trigger: orders.length ? "rebalance" : "hold",
    rationale: orders.length ? "Neutral regime: trimmed 24h laggards, added a defensive nibble on deep overshoot." : "Neutral regime: no edge; deliberately holding (no overtrading).",
    orders,
  };
}

// ---- Qwen adapter ----
function buildSystemPrompt() {
  return [
    "You are VIGIL, an autonomous overnight cross-asset trading agent managing a paper portfolio",
    "of Bitget tokenized US stocks (rToken) and crypto while its owner sleeps.",
    "You are the SOLE decision-maker: sense the context, reason independently, decide, output one JSON object.",
    "",
    "Output ONLY JSON with EXACTLY this shape (no prose):",
    '{"trigger":"macro|news|hedge|rebalance|momentum|sentiment|hold","rationale":"2-3 sentences naming the evidence","orders":[{"action":"BUY|SELL|HEDGE","key":"rnvda","usdMicro":500000000}]}',
    "Rules:",
    "- usdMicro is micro-USD (1e6 = $1). Each order >= $0.10.",
    "- Never SELL more than held. Never buy without recognizing the cash/fee constraint.",
    "- Prefer SELL-before-BUY so rotation is cash-funded.",
    "- At night (window=night) and in a Fear regime, rotate high-beta/crypto into defensive",
    "  index base (rspy/rqqq) and trim crypto. In Greed, you may add modestly to growth.",
    "- 'hold' (empty orders) is a valid and often correct decision — do not trade to trade.",
    "- Honor drawdown and breaker flags; never fight the risk harness.",
  ].join("\n");
}

function buildUserPrompt(state) {
  const s = state;
  const rows = (Object.entries(s.positions || {}).map(([k, p]) =>
    `- ${k}: qty=${Number(p.qty || 0n) / 1e6} val=$${fmt(Number(p.value || 0))} px=$${fmt(Number(p.price || 0))} 24h=${(Number(p.chg24 || 0) * 100).toFixed(2)}%`
  ).join("\n")) || "  (none)";
  return [
    `NAV $${fmt(s.nav)} cash $${fmt(s.cash || 0)} drawdown ${(s.drawdown * 100).toFixed(2)}% window=${s.window} killed=${!!s.killed}`,
    s.regime ? `Macro regime: ${s.regime.regime} (score ${s.regime.score}, F&G ${s.regime.fng ?? "—"}, btc ${s.regime.btc24h}, rToken ${s.regime.equityAvg24h}, breadth ${s.regime.breadth})` : "",
    "Holdings:", rows,
    "Overnight perception:", s.perception ? JSON.stringify({ fearGreed: s.perception.fearGreed, news: (s.perception.news || []).slice(0, 4) }).slice(0, 1600) : "  (none)",
    "Risk flags:", `breaker=${!!s.breaker} killed=${!!s.killed}`,
    "Decide now.",
  ].filter(Boolean).join("\n");
}

function fmt(m) { const n = Number(m) / 1e6; return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

export function llmFactory() {
  const mode = String(LLM_MODE || "stub").toLowerCase();
  if (mode === "stub") return { mode: "stub", decide: decideStub, review: reviewStub, reviewerModel: "deterministic-auditor" };

  // qwen = Bitget's sponsor endpoint; live = any OpenAI-compatible provider (env-wired).
  const base = mode === "qwen" ? QWEN_BASE_URL : (process.env.VIGIL_LLM_BASE_URL || QWEN_BASE_URL);
  const model = mode === "qwen" ? QWEN_MODEL : (process.env.VIGIL_LLM_MODEL || QWEN_MODEL);
  const key = mode === "qwen" ? process.env.VIGIL_QWEN_API_KEY : process.env.VIGIL_LLM_API_KEY;
  if (!key) {
    console.warn("VIGIL: live-LLM mode requested but no API key wired — falling back to stub. Set VIGIL_LLM_API_KEY.");
    return { mode: "stub", decide: decideStub, review: reviewStub, reviewerModel: "deterministic-auditor" };
  }
  const resolvedMode = mode === "qwen" ? "qwen" : "live";
  const provider = mode === "qwen" ? "bitget-qwen" : (base || "custom");
  return {
    mode: resolvedMode, model, provider,
    decide: (state) => decideLive(state, base, model, key),
    // Reviewer: prefer the LLM; if it's rate-limited/unavailable (e.g. a transient
    // 429 on the capped key), fall back to the deterministic auditor rather than
    // failing closed — a real verdict rides into every plan either way, and the
    // risk harness (which always survives a reject) is never blocked.
    review: async (d) => {
      try { return await reviewLive(d, base, model, key); }
      catch (e) { return { ...reviewStub(d), fallback: true, fallbackReason: String(e?.message || e) }; }
    },
    reviewerModel: `${model} (audit)`,
  };
}

async function decideLive(state, base, model, key) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(state) },
    ],
    temperature: 0.2,
    max_tokens: 4000,
  });
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content;
      if (!text) throw new Error("llm empty completion");
      return parseDecision(text);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---- TWO-MODEL AUDIT: a second "reviewer" criticizes the decision before execution.
// The reviewer is strict by construction: it must reject any plan that would
// increase drawdown exposure, exceed concentration/cash bounds, or trade against
// an armed breaker. Verdicts are logged into the signed decision (review_verdict).

// Deterministic auditor (stub mode): hard rules, zero LLM cost. Used when no LLM key.
export function reviewStub({ state, decision }) {
  const orders = (decision && decision.orders) || [];
  const problems = [];
  const nav = Number(state?.nav || 0);
  const isBuy = (a) => a === "BUY" || a === "HEDGE";
  const isDeRisk = (a) => a === "SELL" || a === "LIQUIDATE";
  if (state?.breaker || state?.killed) {
    if (orders.some((o) => isBuy(o.action))) {
      problems.push("breaker/kill armed but plan still proposes buys");
    }
    for (const o of orders) {
      if (!isDeRisk(o.action)) problems.push(`order ${o.key} not a de-risk while breaker is armed`);
    }
  }
  for (const o of orders) {
    const usd = Number(o.usdMicro || 0);
    if (!state?.breaker && !state?.killed) {
      // Concentration: no single order may exceed 25% of NAV. (Cash affordability is
      // enforced by the executor itself — a separately-tested, load-bearing property.)
      if (usd > nav * 0.25) problems.push(`${o.key} order ($${(usd / 1e6).toFixed(0)}) exceeds 25% of NAV`);
    }
    if (!o.action || !o.key || usd <= 0) problems.push("malformed order (missing action/key or zero value)");
  }
  if (problems.length) {
    return { verdict: "reject", reason: "Deterministic audit: " + problems.join("; ") };
  }
  return { verdict: "pass", reason: "Deterministic audit: plan respects breaker, cash and concentration bounds." };
}

function buildReviewPrompt({ state, decision }) {
  return [
    "You are VIGIL's independent AUDITOR — adversarial by design. The decision-maker proposed a trade plan;",
    "your job is to find reasons it must NOT execute. You are NOT the decision-maker; you are the skeptic.",
    "",
    "Audit rules (REJECT if any holds):",
    "- breaker or killed flags are set but the plan still BUYs/HEDGEs (only de-risk allowed)",
    "- any SINGLE order > 25% of NAV, or a SELL of an asset not currently held, or a LIQUIDATE with nothing held",
    "- the plan increases drawdown exposure when drawdown is already >50% of the breaker threshold",
    "- a BUY/HEDGE that SELLs nothing to fund it ONLY when no cash exists AND no same-plan SELL covers it",
    "  (rotation is self-funded SELL-before-BUY — the executor enforces cash; do NOT reject a rotation",
    "  that funds its buys from its own SELL proceeds, even if opening cash is ~0)",
    "- any order with malformed/incomplete fields",
    "",
    "Return ONLY JSON: {\"verdict\":\"pass\"|\"reject\",\"reason\":\"1-2 sentences naming the exact violation, or why the plan is sound\"}",
    "",
    `NAV $${Number(state?.nav || 0) / 1e6} cash $${Number(state?.cash || 0) / 1e6} drawdown ${(Number(state?.drawdown || 0) * 100).toFixed(1)}% window=${state?.window} breaker=${!!state?.breaker} killed=${!!state?.killed}`,
    "Proposed plan: " + JSON.stringify(decision?.orders || []),
  ].join("\n");
}

export async function reviewLive({ state, decision }, base, model, key) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: "You are a strict, adversarial trading-plan auditor. Prefer finding the flaw." },
      { role: "user", content: buildReviewPrompt({ state, decision }) },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`review http ${res.status}`);
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content;
      if (!text) throw new Error("review empty completion");
      const verdict = String(text).trim().toLowerCase().includes("reject") ? "reject" : "pass";
      const reason = String(text).slice(0, 400).replace(/```/g, "").trim();
      return { verdict, reason: reason || (verdict === "reject" ? "rejected (no reason)" : "approved") };
    } catch (e) { lastErr = e; }
  } // end retry loop
    // reviewer unreachable — throw so the caller can fall back to the deterministic
    // auditor instead of failing closed on a transient rate-limit/network error
    throw lastErr || new Error("reviewer unreachable");
  }

// Robust extraction: strip markdown fences, find the first balanced JSON object.
function parseDecision(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in qwen output");
  const obj = JSON.parse(t.slice(start, end + 1));
  return { trigger: String(obj.trigger || "rebalance"), rationale: String(obj.rationale || ""), orders: obj.orders || [] };
}