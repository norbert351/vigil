# VIGIL — Architecture

VIGIL is an **LLM-autonomous cross-asset execution agent** for the hours humans sleep. It
manages a mixed Bitget **rToken (tokenized US stocks) + crypto** portfolio overnight and
through weekend market closures, sensing macro/news/sentiment, deciding on its own, and
executing risk-capped orders — every decision signed into a tamper-evident log.

## System diagram

```
                            ┌──────────────────────────────────────────────┐
                            │              Bitget Agent Hub                 │
                            │  (V. Developer Toolkit - sponsor stack)       │
                            └────┬───────────────────────────┬─────────────┘
                                 │                           │
        bitget-mcp-server        │   bitget-signal MCP       │
        US stocks/ETF data       │   crypto macro/news/sent   │
        (agent.bitget.com/mcp)   │   (datahub.noxiaohao.com)  │
            │  read-only, no key │      no key                │
            ▼                    ▼                             ▼
      ┌───────────────────────────────────────────────────────────┐
      │  PERCEPTION (market.js + perception.js + us_mcp.js)        │
      │  live prices · news · Fear&Greed · macro · US quotes       │
      └───────────────────────────┬───────────────────────────────┘
                                  ▼
      ┌───────────────────────────────────────────────────────────┐
      │  LLM = Bitget Qwen qwen3.8-max  (llm.js — DECISION-MAKER) │
      │  sense → reason → propose {orders} over live state        │
      └───────────────────────────┬───────────────────────────────┘
                                  ▼
      ┌───────────────────────────────────────────────────────────┐
      │  RISK LAYER (risk.js)  *always runs, LLM never bypasses*  │
      │  circuit breaker · night-mode · Fear-regime · caps · kill │
      └───────────────────────────┬───────────────────────────────┘
                                  ▼
      ┌───────────────────────────────────────────────────────────┐
      │  TWO-MODEL AUDIT (llm.js review) — adversarial 2nd review │
      │  rejects → drop LLM legs; risk legs always survive        │
      └───────────────────────────┬───────────────────────────────┘
                                  ▼
      ┌───────────────────────────────────────────────────────────┐
      │  EXECUTOR (executor.js)  paper ledger OR Bitget demo      │
      │  venue (PAPTRADING:1 crypto legs; rToken paper-fallback)  │
      └───────────────────────────┬───────────────────────────────┘
                                  ▼
      ┌───────────────────────────────────────────────────────────┐
      │  LEDGER (db.js: dual-mode sqlite / Neon pg)               │
      │  positions · cash · realized P&L · signed decision log     │
      │  equity curve · alerts · per-session books                  │
      └───────────────────────────────────────────────────────────┘
```

## The core value flow (the spine)

Every ~5-minute cycle (`agent.js → runSweep`):

1. **Sense** — pull live rToken + crypto prices (`market.js`), US-stock quotes from the
   official `bitget-mcp-server` (`us_mcp.js`), and overnight context (news, macro, Fear &
   Greed) from `bitget-signal` MCP + public fallbacks (`perception.js`).
2. **Reason** — the LLM (**Qwen `qwen3.8-max`**, the decision-maker) reads the live portfolio
   state + overnight perception and returns `{trigger, rationale, orders}`.
3. **Risk-gate** — `risk.js` hard-gates before any order: drawdown circuit breaker, night
   mode, Fear-regime rotation, order-size + concentration caps.
4. **Audit** — a second (adversarial) reviewer criticises the complete plan; a rejection
   drops the LLM's discretionary legs.
5. **Execute** — settle on a cash-correct paper ledger at live prices, or through Bitget's
   demo venue (`VIGIL_EXEC=bitget`) for crypto legs with rTokens as labelled paper-fallback.
6. **Sign & log** — each decision is bound to `{window, nonce, ts, nav, trigger, prices,
   orders, context}` and signed `VIGIL-<sha256>` into the ledger + committed paper-log.

## Why the sponsor stack is load-bearing — "After removing <X> | What happens"

| Sponsor tech removed | What happens to the product |
|---|---|
| **Bitget Qwen `qwen3.8-max`** (decision-maker) | The agent can no longer reason autonomously — falls to a deterministic stub with no real macro/news judgment. The core "LLM decides" thesis stops. |
| **bitget-mcp-server US data** | US-equity pricing/backtest loses its primary real-venue source; rToken legs rely on the slower public ticker feed and the backtest on Bitget candles. Recall degrades to fallback. |
| **bitget-signal MCP perception** | The agent is blind to overnight news/macro/sentiment — no event → decision → execution driver. It can only react to price, not to what moved the price. |
| **Bitget UTA v3 / Agent Hub demo (PAPTRADING:1)** | Real signed paper-venue execution disappears — the "autonomous places orders with risk controls" flow becomes a local simulation only. |

Remove all four and VIGIL is a hardcoded rule engine rebalancing a spreadsheet — the entire
judged thesis ("LLM autonomously senses, judges, executes with risk controls") stops being
real. Each sponsor surface is called in code, not just claimed in prose (see
`docs/rubric.md` for the grep-verifiable residency).

## Key modules

| File | Responsibility |
|---|---|
| `src/agent.js` | The orchestration loop: sense → reason → risk → audit → execute → sign. |
| `src/llm.js` | LLM seam + two-model auditor. Qwen sponsor (`VIGIL_LLM=qwen`) or OpenAI-compatible fallback; deterministic stub for tests. |
| `src/risk.js` | Hard risk layer (breaker, night-mode, Fear-regime, caps) — always runs. |
| `src/executor.js` | Cash-correct paper settlement + Bitget demo-venue execution with capability-aware rToken fallback. |
| `src/venue.js` | Signed Bitget UTA v3 client (HMAC, PAPTRADING:1 demo routing, symbol capability). |
| `src/market.js` | Bitget public rToken + crypto ticker feed, resolved to the curate universe. |
| `src/us_mcp.js` | Official `bitget-mcp-server` (US stocks/ETF quotes + history, read-only, no key). |
| `src/perception.js` | Overnight context (news, macro, Fear & Greed) via bitget-signal MCP + fallbacks. |
| `src/regime.js` | Cross-asset macro regime (risk-on/neutral/risk-off) from price action + Fear & Greed. |
| `src/db.js` / `db-pg.js` / `db-sqlite.js` | Dual-mode ledger: positions, cash, realized P&L, signed decision log, equity curve — sqlite by default, async Postgres on Neon (`vigil` schema) when `VIGIL_DATABASE_URL` set. |
| `src/analytics.js` | Sharpe, max drawdown, win-rate, realized P&L. |
| `src/backtest.js` | Historical backtest on real Bitget candles + US-MCP equity closes + Fear & Greed. |
| `src/index.js` | HTTP + SSE dashboard, REST, paper-log CSV export, dryRun, US-MCP endpoints. |
| `src/report.js` | Overnight sleep report with LLM narration. |
| `src/sessions.js` / `src/leaderboard.js` / `src/timeline.js` | Multi-session Connect platform, leaderboard, night timeline. |
| `src/alerts.js` | Break-glass webhooks (breaker, kill, NAV move, venue errors). |