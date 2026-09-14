// VIGIL — LLM decision seam.
// Decision-maker per the Agentic Trading thesis: the LLM IS the primary trading
// decision-maker (not an assistant). Two modes behind one interface:
//   qwen = Qwen (qwen3.8-max) via Bitget's hackathon endpoint (LLM_MODE=qwen)
//   stub = deterministic reasoning (no network; used in tests + as a safe fallback)
// The seam so the Qwen key can be swapped in without touching the loop.
import { LLM_MODE, QWEN_BASE_URL, QWEN_MODEL } from "./config.js";

// Build the structured prompt from live state. Returns a decision JSON the caller
// executes. Everything the agent sees is signed into the manifest for explainability.
function buildSystemPrompt() {
  return [
    "You are VIGIL, an autonomous overnight cross-asset trading agent managing a paper portfolio",
    "of Bitget tokenized US stocks (rToken) and crypto while its owner sleeps.",
    "",
    "You are the SOLE decision-maker. Sense the context, reason independently, decide, and output",
    "one JSON decision object. You must obey the risk rules. You must act autonomously but defensively.",
    "",
    "Output ONLY JSON with this EXACT shape (no markdown, no prose):",
    '{',
    '  "trigger": "macro|news|cross-move|sentiment|risk|rebalance|hedge|hold",',
    '  "rationale": "a short 2-3 sentence explanation of why, naming the evidence",',
    '  "orders": [',
    '    {"action":"BUY","key":"rnvda","usdMicro":123000000},',
    '    {"action":"SELL","key":"btc","usdMicro":50000000}',
    '  ]',
    '}',
    "Rules you MUST respect:",
    "- Each order's usdMicro (micro-USD, 1e6=$1) must exceed the account's minimum notional.",
    "- Never SELL more of an asset than the portfolio holds.",
    "- If the risk check is already done in the context, honor it; do not fight the safety layer.",
    "- 'hold' (empty orders) is a valid, often correct decision — do not trade just to trade.",
  ].join("\n");
}

function buildUserPrompt(state) {
  const s = state;
  return [
    "## Live portfolio (micro-USD = $1):",
    `NAV: $${fmtUsd(s.nav)}  Equity: $${fmtUsd(s.equity)}  Drawdown: ${(s.drawdown * 100).toFixed(2)}%  Window: ${s.window}`,
    "",
    "## Held positions:",
    (Object.entries(s.positions).map(([k, p]) =>
      `- ${k}: qty=${p.qty} val=$${fmtUsd(p.value)} px=$${p.price} 24h=${(p.chg24 * 100).toFixed(2)}% target=${p.target ? (p.target * 100).toFixed(0) + "%" : "n/a"}`
    ).join("\n") || "  (none)"),
    "",
    "## Overnight perception:",
    s.perception ? JSON.stringify(s.perception).slice(0, 2500) : "  (perception unavailable — decide on price/risk only)",
    "",
    "## Risk flags:",
    `  breaker_tripped=${s.breaker ? "YES — force liquidate to defense / halt" : "no"}`,
    "",
    "Decide now.",
  ].join("\n");
}

function fmtUsd(micro) { const n = Number(micro) / 1e6; return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

// Deterministic stub: mirrors what the real decision policy does, so tests + fallback
// are coherent. It reads price momentum, drawdown, and the risk layer.
export async function decideStub(state) {
  const orders = [];
  let trigger = state.breaker ? "risk" : state.window === "night" ? "macro" : "rebalance";
  let rationale;

  if (state.breaker) {
    rationale = "Circuit breaker tripped: liquidating non-cash risk / moving to defense for the night.";
    for (const [k, p] of Object.entries(state.positions)) {
      if (p.qty > 0 && isRiskAsset(k)) orders.push({ action: "SELL", key: k, usdMicro: p.value });
    }
  } else {
    // Simple realized-momentum tilt: trim laggards (chg24 < -2%) modestly, add to a
    // cheap laggard (chg24 < -4%) only if drawdown is healthy.
    const canAdd = state.drawdown < 0.04;
    for (const [k, p] of Object.entries(state.positions)) {
      if (p.qty > 0 && p.chg24 != null && p.chg24 < -0.025 && isRiskAsset(k)) {
        const trim = Math.min(p.value, Math.round(state.nav * 0.05));
        orders.push({ action: "SELL", key: k, usdMicro: trim });
      } else if (canAdd && p.qty >= 0 && p.chg24 != null && p.chg24 < -0.05 && !isRiskAsset(k)) {
        // mean-reversion nibble on a deep-drawn risk asset (only the stakeholder's target names)
        orders.push({ action: "BUY", key: k, usdMicro: Math.round(state.nav * 0.03) });
      }
    }
    rationale = "Momentum-risk stub: trimmed the sharp 24h laggards, added a small nibble to a deep overshoot while drawdown is healthy.";
  }
  if (orders.length === 0) trigger = "hold";
  return { trigger, rationale, orders };
}

function isRiskAsset(key) {
  return !["rspy", "rqqq", "raapl"].includes(key); // keep stable core names as base
}

export function llmFactory() {
  const mode = String(LLM_MODE || "stub").toLowerCase();
  if (mode !== "qwen") {
    return { mode: "stub", decide: decideStub };
  }
  return { mode: "qwen", decide: decideQwen };
}

async function decideQwen(state, apiKey) {
  const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(state) },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`qwen http ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error("qwen empty completion");
  return JSON.parse(text); // { trigger, rationale, orders[] }
}