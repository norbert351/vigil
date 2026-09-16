# VIGIL — Product Roadmap

**Status:** Bitget AI Hackathon S2 · Agentic Trading · Cross-Asset Execution Agent
**Deadline:** 9/21 · **Repo:** github.com/norbert351/vigil · **Live:** vigil-mg0m.onrender.com

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

### Multi-session platform
- Isolated ledger + sweep loop per connected book; owner-key auth on every mutating route
- AES-256-GCM credential storage, per-IP rate cap, 8-session capacity, **live-account keys rejected**, one-account-one-agent guard
- Restart recovery: sessions resume their loops after a redeploy

### Differentiators shipped this round
1. **Two-model decision audit** — a second reviewer criticizes the plan before execution; verdict + reason are written into the signed log (fail-closed if the reviewer is unreachable)
2. **Break-glass alerts** — webhook (Telegram/Discord/Slack/generic) on breaker trips, kill-switch, ≥3% NAV moves, and venue order failures; deduped per type
3. **Session leaderboard**
4. **Event-aligned night timeline**
5. **Overnight sleep report**

---

## 🔜 Next candidates

### 1. Audit analytics dashboard
Rejection-rate over time, which rules fire most, and the counterfactual "what would the rejected plan have cost?" — turns the audit from a per-row verdict into evidence that the reviewer adds value.
**Gate:** needs ≥20 audited decisions to be meaningful.

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
