# VIGIL — Product Roadmap

**Status:** Bitget AI Hackathon S2 · Agentic Trading · Cross-Asset Execution Agent
**Deadline:** 9/21 · **Repo:** github.com/norbert351/vigil · **Live:** vigil-mg0m.onrender.com

---

## ✅ Shipped

- **Live LLM decision-maker** — Gemini via OpenAI-compatible seam; Qwen sponsor swap one-var (`VIGIL_LLM=qwen`)
- **Real venue execution** — signed UTA v3 spot orders on Bitget's paper-trading env (`PAPTRADING:1`), ledger re-syncs to venue truth; verified fills (BTC/ETH)
- **Capability-aware hybrid routing** — rTokens are halted in the demo venue → clearly-labelled `paper-fallback` legs, never faked as venue fills
- **Risk harness** — night-mode + Fear-regime rotation, drawdown breaker (10% day / 5% night), kill-switch, order-size + concentration caps
- **Signed decision log** — every cycle bound to {window, nonce, ts, nav, prices, orders} → `VIGIL-<sha256>`, replayable + committed CSV
- **Full UI** — navy/light-blue landing (`/`), command center (`/app`), live ticker, SSE stream, 390px-clean, 22/22 tests
- **Multi-session Connect flow** — BYO demo key → `/connect` → isolated book, encrypted-at-rest creds (AES-256-GCM), owner-key auth, per-book dashboard + metrics + decision log, restart-recovery, live-key rejection gate

## 🔜 Next candidates (recommended order)

### 1. Two-model decision audit: "the LLM proposes, the LLM verifies"
A second LLM call (same model, adversarial prompt) reviews the first decision *before*
execution and returns PASS / REJECT + reasoning. Both survive in the signed log.
- **Why unique:** every agent has a risk layer — almost none show a second *model*
  critiquing the first. Turns "risk-gated decisions" from a claim into a visible,
  judge-clickable artifact (rejected orders with reasons in the log).
- **Effort:** ~1 day. New seam in `llm.js`, one log column, dashboard display.
- **Gate:** rejected-order rate must be non-zero at demo time — run it on the live
  book for 24–48h and show real rejections.

### 2. Overnight "sleep report" (auto-generated morning debrief)
Every morning, VIGIL composes a dated HTML/PDF digest: what happened overnight, the
news/macro it acted on, its trades, NAV move vs a do-nothing baseline, and a
one-paragraph plain-language explanation. Committed to the repo + served at
`/reports/latest`.
- **Why unique:** the product *narrates* the hours humans slept back to them — the
  thesis made tangible. Deeper storytelling than any live chart; ideal Demo Day prop.
- **Effort:** ~1 day (template + LLM summarization + nightly cron).
- **Gate:** must run a real overnight before submission.

### 3. Session leaderboard (`/leaderboard`)
Public ranking of all connected books by NAV return, Sharpe, max-DD and decision
density — one row per session, "live" pulse, links to each book's page.
- **Why unique:** the multi-session foundation already exists; a leaderboard turns a
  single-tenant demo into a *community* — competitors + a reason to connect.
- **Effort:** ½ day (query per-book metrics, sort, render).
- **Gate:** needs ≥2-3 live sessions to look real; seed with the flagship + invite judges.

### 4. Break-glass alerts (Telegram/Discord webhook)
Breaker trips, kill-switch events, drawdown >X%, or a >2σ venue move → instant
notification with the signed decision hash. Owner-configurable per session.
- **Why unique:** real overnight operation needs a phone that buzzes — "it's
  watching" stops being a pitch and becomes a ping.
- **Effort:** ½ day (webhook URL per session + event hook in the sweep loop).

### 5. Event-aligned night timeline (`/app?tab=night`)
One visual timeline of the overnight window: macro/news timestamps (from the
perception feed) overlaid with the agent's trades + NAV markers, so a judge sees the
*why* at a glance (CPI at 2am → defensive rotation at 2:04).
- **Why unique:** turns the signed log into a story; no other entry maps events →
  decisions on one axis.
- **Effort:** 1 day (merge decisions + perception timestamps, render).
- **Gate:** needs an eventful night captured before judging.

---

## Not now (deliberately)

- **Live-account support / real money** — the Connect gate rejects live keys by
  design; VIGIL is demo-venue-first, real-funds rails are a post-hackathon product
  decision (custody, insurance, withdrawal UX).
- **User accounts/billing/quotas** — sessions currently cap at 8 for the free
  instance; the leaderboard + rate limit make it abuse-tolerant, not a business yet.