# VIGIL — Judge-Verification Map (docs/rubric.md)

**Event:** Bitget AI Hackathon S2 · **Track 2 · Agentic Trading** · **Sub-theme:** Cross-Asset Execution Agent
**Source (LIVE):** https://bitget-ai.gitbook.io/bitgetai_hackathons2 (pulled 2026-09-17)
**Deadline:** 27 Sep 2026 (UTC+8) · **Repo:** github.com/norbert351/vigil

This map is the anti-overclaim artifact: for every judging criterion, it points at the **exact
file, endpoint, or command** that settles it. A judge can verify any row in minutes.

---

## Track 2 · Agentic Trading — Scoring

> **Scoring mechanism: 50% quantitative + 50% judge scoring.** (verbatim, live page)

> **Judging focus:** Paper trading Sharpe, max drawdown, win rate; decision explainability;
> Agent architecture quality; risk control layer effectiveness. (verbatim, live page)

> **Submission requirements:** Runnable Demo + demonstrate a complete event → decision →
> execution flow (simulated or paper trading acceptable) · **Paper trading log Required**
> (actually run during competition period) · **Compliant X post link Required**
> (`#BitgetHackathon` + `@Bitget_AI`).

> **Sub-theme:** Cross-Asset Execution Agent — *How does the Agent manage rToken and Crypto
> positions simultaneously? Hedge Crypto when rToken anomalies; dynamic cross-market
> allocation after macro shocks.*

---

## Verification matrix

| Criterion (weight) | Where the evidence is | Verified? |
|---|---|---|
| **Paper-trading Sharpe / max drawdown / win rate (quant)** | `GET /api/metrics` on the live agent; equity curve at `GET /api/equity`. Derivation in `src/analytics.js` (Sharpe from NAV curve, max-DD from peak-to-trough, win-rate + realized P&L from closed SELLs). Live log also carries per-decision NAV. ⚠️ **win-rate/realized-P&L are order-level and inflated by the venue cost-basis approximation (avgCost≈price on re-sync ⇒ a near-market sell reads as ≈full-notional profit ⇒ win-rate→1.0). The NAV-based Sharpe/max-DD are the defensible numbers.** | ✅ VERIFIED 2026-09-18 (metrics live on deployed; committed paper-log 700+ decisions) |
| **Decision explainability** | Every decision binds its *context the agent saw* → `GET /api/decisions` (each has rationale + `review_verdict`); committed CSV `docs/paper-log/vigil-decision-log.csv` carries `rationale`, `orders`, `review_verdict`, `review_rationale`. Signed manifest `VIGIL-<sha256>` (see `src/engine.js: signManifest`). | ✅ VERIFIED (all decisions have signed manifest + context; csv grep-able) |
| **Agent architecture quality** | `ARCHITECTURE.md` (system diagram + counterfactual table); `docs/TECHNICAL.md`; clean module split in `src/`. | ✅ VERIFIED (docs written 2026-09-17) |
| **Risk control layer effectiveness** | `src/risk.js` — drawdown breaker (10% day / 5% night), kill-switch, order-size + concentration caps, night gross limit, Fear-regime rotation. Tests: `test/vigil.test.js` (breaker, night-mode, caps, kill-switch). Evidence of firing: `review_verdict: reject` rows where the auditor caught an over-cap / unfunded buy. | ✅ VERIFIED (code + tests + live reject verdicts) |
| **LLM is the decision-maker (not an assistant)** | `src/llm.js` — Qwen `qwen3.8-max` returns `{trigger, rationale, orders}`; log records `model: qwen3.8-max @ bitget-qwen`. | ✅ VERIFIED (live log) |
| **Complete event → decision → execution flow (required)** | `src/agent.js runSweep`: sense → reason → risk → audit → execute → sign every ~5 min. Live proof: committed paper-log with dated decisions, racking NAV, actual order legs. | ✅ VERIFIED (live paper-log, orders with px/pnl/fee) |
| **Paper-trading log actually run (required)** | `docs/paper-log/vigil-decision-log.csv` (495+ rows, dated, auto-refreshed by cron). | ✅ VERIFIED 2026-09-17 (487 decisions, committed) |
| **Runnable Demo (required)** | Live: https://vigil-mg0m.onrender.com (`/`, `/app`, `/api/*`). Local: `npm start`. | ✅ VERIFIED 2026-09-18 — deployed ledger now persistent on Neon (`vigil` schema): the full 600+ decision history + equity curve is served live and **no longer resets on free-tier redeploy** (was the #1 pre-submit gap) |
| **Sponsor-tech residency (Qwen + bitget-mcp-server + bitget-signal + UTA v3)** | `grep hackathon.bitgetops.com src/llm.js src/report.js` · `grep agent.bitget.com/mcp src/us_mcp.js` · `grep datahub.noxiaohao.com src/perception.js` · `grep PAPTRADING src/venue.js src/executor.js` — all load-bearing, all called in the loop, none mock. | ✅ VERIFIED (grep + live calls); counterfactual in `ARCHITECTURE.md` |
| **Compliant X post (#BitgetHackathon + @Bitget_AI)** | `docs/SUBMISSION.md` §1 — mandatory X post draft (must be posted + link attached at submission). | ❌ USER-GATED (must post + attach link; draft ready) |
| **Qwen credits / sponsor usage noted** | `docs/SUBMISSION.md` Part 6 / form — state Qwen used as decision-maker + whether it met needs. | ⚠️ form field, ready to fill |

### Honest "we did not do" rows
- **No real-money / no live-account alpha** — this is a *paper* agent by design for a
  simulated/paper track. Real venue execution exists (Bitget demo) but only crypto legs
  fill on the venue; rTokens are halted in the demo and route as labelled paper-fallback.
- **No human-in-the-loop trading desk** — that is Track 3 (AI Trading Desk); VIGIL is
  intentionally an *autonomous* decision-maker per Track 2's positioning.

---

## How a judge reproduces the key claims

```bash
# core claims in minutes
git clone https://github.com/norbert351/vigil && cd vigil
npm test                                   # 34/34 green
npm start &                               # local agent
curl localhost:8080/health                # llm=qwen, deadline 2026-09-27
curl localhost:8080/api/metrics            # live Sharpe/maxDD/win-rate/realized P&L
curl localhost:8080/api/us-market?symbol=TSLA   # bitget-mcp-server US quote (no key)
curl -s localhost:8080/api/decision-log.csv | head   # signed, audited paper-log
```

```bash
# sponsor residency (grep, not prose)
grep -rn "hackathon.bitgetops.com" src/     # Qwen sponsor
grep -rn "agent.bitget.com/mcp" src/        # bitget-mcp-server US data
grep -rn "PAPTRADING" src/executor.js       # demo-venue execution
```