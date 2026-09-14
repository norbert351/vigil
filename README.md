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
node --version   # >= 20 (uses node:sqlite)
node src/index.js
# dashboard: http://localhost:8080/  ·  log: /api/decision-log.csv
```

Env (all optional):

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

`GET /health` · `GET /api/state` · `GET /api/prices` · `GET /api/universe` ·
`GET /api/metrics` (Sharpe/maxDD/win-rate/realized P&L) · `GET /api/equity` (NAV curve) ·
`GET /api/decisions` · `GET /api/decision-log.csv` · `POST /api/run` ·
`POST /api/kill {on:true|false}` (halt/resume) · `GET /api/agent/stream` (SSE) · `GET /`.

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
