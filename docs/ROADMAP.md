# VIGIL — Product Roadmap

**Status:** Bitget AI Hackathon S2 · Agentic Trading · Cross-Asset Execution Agent
**Deadline:** 9/27 (UTC+8, per live event page) · **Repo:** github.com/norbert351/vigil · **Live:** vigil-mg0m.onrender.com

---

## ✅ Shipped

### Core agent
- **Live LLM decision-maker** — Gemini via OpenAI-compatible seam; Qwen sponsor swap one-var (`VIGIL_LLM=qwen`)
- **Real venue execution** — signed UTA v3 spot orders on Bitget's paper-trading env (`PAPTRADING:1`); verified fills (BTC/ETH)
- **Capability-aware hybrid routing** — rTokens are halted in the demo venue → clearly-labelled `paper-fallback` legs, never faked as venue fills
- **Risk harness** — night-mode + Fear-regime rotation, drawdown breaker (10% day / 5% night), kill-switch, order-size + concentration caps
- **Signed decision log** — every cycle bound to {window, nonce, ts, nav, prices, orders} → `VIGIL-<sha256>`, replayable + committed CSV

### Surfaces
- **Landing** (`/`) — navy/light-blue identity, Pexels night-city hero with text on image, live ticker, animated sections
- **Command center** (`/app`) — KPIs, allocation, holdings, signed log with **audit verdicts**, SSE stream, kill-switch
- **Connect** (`/connect`) — BYO demo-key onboarding: read-only validation, demo-only gate, encrypted at rest
- **Leaderboard** (`/leaderboard`) — live ranking of every connected book
- **Night timeline** (`/night`) — headlines + decisions + fills aligned with the NAV curve on one axis
- **Sleep report** (`/reports/latest`) — auto-generated morning digest with LLM narration

### Dev Toolkit alignment (this round)
- **bitget-mcp-server** (`agent.bitget.com/mcp`, read-only, no key) wired as the US stock/ETF
  data layer: `/api/us-market`, `/api/us-history`, `/api/us-universe` cross-check every rToken
  against its live US quote; backtest prefers real US-MCP daily closes.
- **`dryRun`**: `GET /api/run?dry=1` previews sense→reason→orders→audit without writing the
  ledger (toolkit: "any write can be previewed with dryRun").
- **Qwen sponsor endpoint** (`hackathon.bitgetops.com/v1`) as the live decision-maker.
- Sleep-report narration now follows the configured LLM seam (Qwen), not a hard-coded Gemini URL.

### Multi-session platform
- Isolated ledger + sweep loop per connected book; owner-key auth on every mutating route
- AES-256-GCM credential storage, per-IP rate cap, 8-session capacity, **live-account keys rejected**, one-account-one-agent guard
- Restart recovery: sessions resume their loops after a redeploy

### Differentiators shipped this round
1. **Two-model decision audit** — a second reviewer criticizes the **complete proposed plan**
   (risk-layer AND LLM legs) before execution; verdict + reason are written into every signed
   decision (fail-closed if the reviewer is unreachable). A rejection drops only the LLM's
   discretionary legs — the risk harness's own orders always survive.
2. **Break-glass alerts** — webhook (Telegram/Discord/Slack/generic) on breaker trips, kill-switch, ≥3% NAV moves, and venue order failures; deduped per type
3. **Session leaderboard**
4. **Event-aligned night timeline**
5. **Overnight sleep report**

> **Audit evidence (2026-09-17):** the auditor previously fired only on LLM-discretionary
> plans, so while the live agent ran mostly risk-harness rebalances the log carried no
> verdicts. Fixed to audit every executed plan, backfilled the executed history, and the
> running agent now produces audited decisions live. Committed paper-log carries the
> `review_verdict` column.

---

## 🔜 Next candidates

### 1. Audit analytics dashboard
Rejection-rate over time, which rules fire most, and the counterfactual "what would the rejected plan have cost?" — turns the audit from a per-row verdict into evidence that the reviewer adds value.
**Gate: CLEARED.** The ≥20-audited-decisions bar was reached on 2026-09-17 (the committed log
carries 280+ audited decisions). This is now the highest-value next builder: the audit data is
real and ready to become a judge-quantifiable evidence chart.

### 2. Multi-venue execution (OKX / Hyperliquid)
The venue client is already a factory (`createVenueClient`) — a second adapter would prove the architecture generalises beyond one exchange and hedge venue-specific halts.
**Gate:** needs a second venue's demo credentials + symbol-capability map.

### 3. Sleep-report email/push delivery
Reports currently live at a URL; a scheduled delivery (email or the alert webhook) makes the product's ritual real — "wake up, read what your agent did".
**Gate:** needs an email provider key or a user-supplied webhook.

### 4. Strategy profiles per book
Let a connected book pick a stance (defensive / balanced / momentum) that reshapes targets + caps, versioned in the signed log so a judge can compare behaviours side by side.
**Gate:** needs a backtest comparison across profiles to show the difference is real.

### 5. On-chain attestation of the decision log
Publish the daily log hash to a public chain so the audit trail is tamper-evident beyond our own database.
**Gate:** cost + a chain choice; only worth it once the log is the headline claim.

---

## Not now (deliberately)

- **Live-account support / real money** — the Connect gate rejects live keys by design; real funds need custody, insurance and withdrawal UX decisions that are out of scope for a demo-venue product.
- **User accounts / billing / quotas** — sessions cap at 8 for the free instance; the rate limit and leaderboard make it abuse-tolerant, not yet a business.
