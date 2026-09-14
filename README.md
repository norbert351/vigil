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
| `VIGIL_LLM` | `stub` | `stub` \| `qwen` |
| `VIGIL_QWEN_API_KEY` | — | Qwen key (enables `VIGIL_LLM=qwen`) |
| `VIGIL_SCAN_MS` | 300000 | decision cadence |
| `VIGIL_MAX_DD` | 0.10 | circuit-breaker drawdown |

Tests: `node --test` (9 specs — valuation, signed manifests, risk caps, breaker,
no-oversell execution, decision log, stub policy).

## Endpoints

`GET /health` · `GET /api/state` · `GET /api/prices` · `GET /api/decisions` ·
`GET /api/decision-log.csv` · `GET /api/universe` · `POST /api/run` ·
`GET /api/agent/stream` (SSE) · `GET /` (dashboard).

## Architecture

```
market.js (Bitget rToken+crypto)      perception.js (Bitget MCP + RSS + F&G)
        \                              /
         v                            v
        agent.js  — sense → LLM (llm.js) → risk.js gate → executor.js → sign (engine.js)
         |                                                              |
        db.js (node:sqlite ledger: positions · decisions · orders)      |
         \__________________________ index.js (HTTP + SSE dashboard) __/
```

## Honest status

- **Verified**: live rToken + crypto prices (12-symbol universe resolves on Bitget),
  end-to-end loop, 9/9 tests, signed decision log, live perception (news + Fear&Greed),
  dashboard + CSV export.
- **Paper by design**: execution is `simulated` at the live market price. Live rToken
  settlement requires the Bitget Agentic account + API credentials.
- **LLM seam**: Qwen is wired (`llm.js`) but the API key is provisioned via Bitget KYC;
  until then the deterministic stub runs the identical loop.

*Not financial advice. Novel-aggressive strategy; no capital at risk in paper mode.*
