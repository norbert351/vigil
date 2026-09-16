# VIGIL — the agent for the hours humans sleep

**Bitget AI Base Camp Hackathon S2** · Track: **Agentic Trading** · Sub-theme: **Cross-Asset Execution Agent**

> Tokenized US stocks don't sleep — humans do. VIGIL is an LLM-autonomous agent that
> manages a mixed **Bitget tokenized-US-stock (rToken) + crypto** portfolio **overnight and
> through weekend market closures**, sensing macro/news/sentiment, deciding on its own,
> and executing risk-capped orders — every decision signed and explainable.

---

## The problem

US equities close. Tokenized US stocks (Bitget **rToken**, `R<SYMBOL>USDT`) do not — they
trade 7×24. Over the 2026 Labor Day weekend the NYSE was shut for **89.5 hours** while
tokenized stocks still printed **$1.41 billion** of continuous volume. Prices move on
macro news at 2am Sunday; the human is asleep; nobody rebalances or hedges. And the #1
complaint about the asset class is **execution quality** — thin books and slippage when
you *do* trade.

**VIGIL is the agent that works those hours.**

## What it does

Every cycle (~5 min) the agent:

1. **Senses** — live Bitget market data for rToken + crypto, plus overnight context
   (news, macro, Fear & Greed) from Bitget's market-data MCP (`bitget-signal` backend)
   with fast public fallbacks.
2. **Reasons** — the **LLM is the decision-maker** (Qwen `qwen3.8-max`; a deterministic
   stub runs by default until the Qwen key is provisioned — same loop, swap-in seam).
3. **Risk-gates** — a hard layer runs *before* any order: drawdown circuit breaker, hard
   kill-switch, per-order size cap, single-asset / aggregate-crypto / aggregate-rToken
   concentration caps.
4. **Executes** — paper ledger at the live market price (honest `simulated` label);
   a Bitget UTA v3 demo route sits behind the same seam.
5. **Signs & logs** — each decision is bound to `{window, nonce, ts, nav, trigger,
   prices, orders}` and signed **`VIGIL-<sha256>`** — deterministic, tamper-evident,
   replay-resistant. That signed log **is** the paper-trading record.

## Why the sponsor stack is load-bearing

| Layer | Sponsor tech | Counterfactual |
|---|---|---|
| Decision-maker | **Alibaba Qwen** (`qwen3.8-max`, Bitget endpoint) | remove it → no autonomous reasoning, only fixed rules |
| Sensing | **Bitget market-data MCP** (`bitget-signal`) | remove it → the agent is blind to overnight events |
| Market data | **Bitget UTA v3** public market data | remove it → no live rToken/crypto prices to act on |
| Execution | **Bitget Agent Hub** (UTA v3 / Agentic account, `--paper-trading`) | remove it → no venue to route orders |

## Quick start

```bash
npm install
npm start            # http://localhost:8080 (paper ledger, stub LLM)
npm test             # 15 tests: engine / risk / executor / db / llm
```

## Execution modes

| Mode | `VIGIL_EXEC` | What happens |
|---|---|---|
| **Paper** (default) | unset/`paper` | Cash-correct local ledger at live market prices, fee + slippage, signed manifest log. Zero external credentials. |
| **Bitget demo venue** | `bitget` | Real signed UTA v3 spot market orders on Bitget's **paper-trading environment** (`PAPTRADING:1` — virtual funds only, never real money). Ledger re-syncs to venue truth after every sweep. |

**Capability-aware hybrid routing.** The demo venue publishes its own tradable list (25 symbols). Tokenized stocks appear there as `status:"halt"` and region-restricted, so they cannot be venue-traded. VIGIL asks the venue *before* ordering and routes each leg accordingly:

| Leg | Route | Label in the log |
|---|---|---|
| BTC / ETH (venue-tradable) | **Signed venue order**, real fill pulled back from `orderInfo` | `venue:<orderId>` |
| rToken (venue-halted/absent) | Internal ledger at live market price | `paper-fallback (<venue reason>)` |

Every row in the decision log states which venue actually filled it — the log never presents a simulated leg as a venue fill.

### Bitget venue setup

1. Create a **Demo API key** on Bitget (system-generated, permissions: **Read + Trade**, **no Withdraw**). You get API Key + Secret + Passphrase.
2. Fund the demo **spot** wallet with virtual USDT (Bitget's demo console top-up button — futures demo is auto-funded, spot is not).
3. Export the three values + `VIGIL_EXEC=bitget`:

```bash
export VIGIL_EXEC=bitget
export VIGIL_BITGET_API_KEY=bg_...
export VIGIL_BITGET_SECRET=...
export VIGIL_BITGET_PASSPHRASE=...
npm start
```

`src/venue.js` signs every request (HMAC-SHA256, `ACCESS-*` headers) and normalizes micro-units ↔ venue decimal strings. Credentials live only in your shell or a gitignored `.env` (see `.env.example`) — never in the repo.

## The problem

> US equities close. Tokenized US stocks (Bitget **rToken**, `R<SYMBOL>USDT`) do not — they
> trade 7×24. Over the 2026 Labor Day weekend the NYSE was shut for **89.5 hours** while
> tokenized stocks still printed **$1.41 billion** of continuous volume. Prices move on
> macro news at 2am Sunday; the human is asleep; nobody rebalances or hedges. And the #1
> complaint about the asset class is **execution quality** — thin books and slippage when
> you *do* trade.
>
> **VIGIL is the agent that works those hours.**

## Env (all optional)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | HTTP port |
| `VIGIL_SEED_USD` | 10000 | paper starting equity |
| `VIGIL_EXEC` | `paper` | `paper` \| `bitget` |
| `VIGIL_LLM` | `stub` | `stub` (deterministic) \| `live` (OpenAI-compatible) \| `qwen` (Bitget Qwen) |
| `VIGIL_LLM_BASE_URL` | — | live-mode endpoint (any OpenAI-compatible, e.g. Google) |
| `VIGIL_LLM_MODEL` | — | live-mode model id |
| `VIGIL_LLM_API_KEY` | — | live-mode key |
| `VIGIL_QWEN_API_KEY` | — | Qwen key (sponsor endpoint, `VIGIL_LLM=qwen`) |
| `VIGIL_SCAN_MS` | 300000 | decision cadence |
| `VIGIL_MAX_DD` | 0.10 | circuit-breaker drawdown (day) |
| `VIGIL_NIGHT_DD` | 0.05 | circuit-breaker drawdown (night mode) |
| `VIGIL_FEE_BPS` | 10 | taker fee (bps) |
| `VIGIL_SLIPPAGE_BPS` | 2 | slippage (bps) |
| `VIGIL_REGIME_FEAR` | 35 | Fear & Greed below → defensive tilt |

Tests: `node --test` (15 specs — valuation, signed manifests, night-mode breaker, kill-switch,
Fear-regime rotation, cash-funded buys (no overdraft), fee/slippage, sell-proceeds rotation,
equity-curve analytics, decision log, stub policy).

## Endpoints

**Pages:** `/` (landing) · `/app` (+`?s=<id>` for a connected book) · `/connect` · `/leaderboard` · `/night` · `/reports/latest`

`GET /health` · `GET /api/state` (incl. live macro regime) · `GET /api/prices` · `GET /api/universe` ·
`GET /api/metrics` (Sharpe/maxDD/win-rate/realized P&L) · `GET /api/equity` (NAV curve) ·
`GET /api/backtest?days=90` (real-data strategy backtest) · `GET /api/decisions` (each with `review_verdict`) ·
`GET /api/decision-log.csv` · `GET /api/report` · `GET /api/night-timeline?hours=24` · `GET /api/alerts` ·
`GET /api/leaderboard` · `POST /api/run` ·
`POST /api/kill {on:true|false}` (halt/resume) · `GET /api/agent/stream` (SSE) · `GET /`.

**Multi-session (Connect):** `GET/POST /api/sessions` · `GET /api/sessions/:id/{state,decisions,metrics,alerts,timeline,log.csv}` ·
`POST /api/sessions/:id/{run,kill}` (owner-key header `X-VIGIL-OWNER`).

## Two-model decision audit

The decision-maker proposes; a **second reviewer** criticises the complete plan (risk-layer
and LLM legs) before execution and its verdict is signed into the log (`review_verdict` /
`review_rationale`). A **rejection drops only the LLM's discretionary orders** — the risk
harness's own orders always survive, so de-risking is never blocked. If the reviewer cannot
run, the discretionary plan is withheld — **fail-closed**. The auditor watches what the
executor does **not** (over-concentration >25% NAV, breaker-fighting, malformed orders);
cash-affordability is enforced by the executor's own cash-correct settlement. UI shows
`✓ audit pass` / `✗ audit reject` per decision, and `/night` + `/reports/latest` surface
rejections with the auditor's reasoning. The committed paper-log carries a `review_verdict`
column, so the audit is verifiable offline too.

## Break-glass alerts

Webhook (Telegram / Discord / Slack / generic JSON) fired on: drawdown breaker trip, kill-switch,
≥3% NAV move in one sweep, and venue order failures. Deduped per alert type (30 min default).
Set a per-book webhook at Connect, or a global one via `VIGIL_ALERT_WEBHOOK`.

## What's under the hood

- **Cash ledger** — NAV = cash + positions; BUY is cash-funded (proceeds of same-batch SELLs
  count), so the agent can never conjure money or overdraft.
- **Execution economics** — 10bp taker fee + 2bp slippage on every fill; cost basis tracked
  per position → realized P&L and win rate are computed from real fills.
- **Cross-asset regime hedge** — Fear & Greed drives risk-on/off: in **Fear** (<35) the agent
  trims crypto + high-beta and rotates into the defensive index base (SPY/QQQ); in **Greed**
  (>70) it may add modestly to growth. SELLs are emitted before BUYs so rotation self-funds.
- **Night-mode ("hours humans sleep")** — during the 22:00–06:00 window the circuit breaker
  tightens to 5% (from 10%) and gross exposure is capped, biasing the book to defense while
  nobody is watching.
- **Event → decision traceability** — every decision binds the *context the agent saw*
  (window, hour, NAV, cash, drawdown, Fear & Greed, top headlines, targets) into its signed
  `VIGIL-<sha256>` manifest, so any decision is replayable and auditable.
- **Equity curve + analytics** — each sweep logs NAV to `equity_curve`; `/api/metrics`
  derives Sharpe, max drawdown, win rate and realized P&L (the quant half of the rubric).
- **Live cross-asset macro regime** — the agent computes a risk-on/neutral/risk-off regime from
  live price action (BTC 24h, rToken/crypto breadth) + Fear & Greed, and feeds it to the
  decision-maker and into every signed manifest.
- **Historical backtest (real data)** — `GET /api/backtest` simulates the same strategy on
  up to 90 daily bars of **actual Bitget klines** + historical Fear & Greed (10bp fee + 2bp
  slippage), returning end NA/Sharpe/max-DD/trades for validation.
- **Circuit breaker · kill-switch (file or `POST /api/kill`) · per-order + single-asset +
  aggregate crypto/rToken caps** — the always-on risk harness.

## Architecture

```
market.js (Bitget rToken+crypto)      perception.js (Bitget MCP + RSS + F&G)
        \                              /
         v                            v
        agent.js  — sense → LLM (llm.js) → risk.js gate → executor.js → sign (engine.js)
         |            (night-mode + Fear-regime rotation; cash + fee/slippage settlement)
         |
        db.js (node:sqlite: positions+cost basis · cash · realized P&L · decisions+context · equity_curve)
         \____________________ analytics.js → index.js (HTTP + SSE dashboard + /api/metrics) ____/
```

## Honest status

- **Live data (verified)**: rToken + crypto prices from Bitget's public API (real, moving);
  news (Bitget MCP + Cointelegraph/BBC RSS) + Fear & Greed (alternative.me) — real signals.
- **Live decision-maker (verified)**: the LLM is a REAL model wired through an OpenAI-compatible
  seam (`Gemini 3.6 Flash` runs it today via `VIGIL_LLM=live`); the running agent's log records
  `model: gemini-3.6-flash @ …` with genuine model-written rationales over live state. Bitget
  **Qwen** (`qwen3.8-max`) is a one-var swap (`VIGIL_LLM=qwen` + key) once the sponsor credit is
  provisioned — same seam, same loop.
- **Paper execution by sanctioned rules**: orders settle on a cash-correct paper ledger at the
  live market price (fees + slippage applied). This is what the Agentic Trading track explicitly
  permits (`simulated or paper trading acceptable`). Real-venue execution is a Bitget
  Demo/Agentic API key away — the seam (`EXECUTION_MODE=bitget`) is already present.
- **Tested**: 15/15 specs (cash funding, no-overdraft, fee/slippage, sell-proceeds rotation,
  night breaker, Fear rotation, kill-switch, equity analytics, decision log).

*Not financial advice. Novel-aggressive strategy; no capital at risk in paper mode.*
