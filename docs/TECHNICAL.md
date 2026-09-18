# VIGIL — Technical Documentation

Node 22 agent on `node:http`, with a **dual-mode ledger**: `node:sqlite` by default, and
async **Postgres on Neon** (`pg`) whenever `VIGIL_DATABASE_URL` is set — which is the
deployed path. Beyond `pg`, no framework and no build step — the backend is plain ESM.

## Stack

| Layer | Tech | Version |
|---|---|---|
| Runtime | Node.js (`node:http`, `node:sqlite`, `node:crypto`) | 22 (LTS) |
| Language | Vanilla ESM JavaScript | — |
| Data | SQLite via `node:sqlite` (WAL) by default; **Neon Postgres via `pg`** (`vigil` / `vigil_session_*` schemas) when `VIGIL_DATABASE_URL` is set | built-in + `pg` (prod) |
| Decision-maker | **Alibaba Qwen `qwen3.8-max`** (Bitget sponsor endpoint `hackathon.bitgetops.com/v1`) | OpenAI-compatible |
| US data | `bitget-mcp-server` (`agent.bitget.com/mcp`) — read-only US stocks/ETF | v4.0.3 |
| Crypto data | Bitget UTA v3 public tickers + `bitget-signal` MCP (`datahub.noxiaohao.com/mcp`) | — |
| Execution | Bitget UTA v3 signed demo (`PAPTRADING:1`) — crypto legs | v2 spot |

No third-party runtime dependencies. Tests use Node's built-in test runner.

## How to run

```bash
npm install   # no deps — no-op; included for convention
npm start     # http://localhost:8080 (paper ledger + deterministic stub LLM)
npm test      # 35 tests: engine / risk / executor / db / llm / audit / US MCP / dryRun
```

To run the real decision-maker (Qwen) + demo venue, set env — see `README.md` → "Execution
modes" / "Env".

## The decision pipeline (agent.js → runSweep)

One cycle ≈ every 5 min (`VIGIL_SCAN_MS`). Steps:

1. **Sense** — `refreshPrices(true)` pulls live Bitget rToken/crypto prices; `perception.js`
   refreshes overnight context in the background and caches it; `us_mcp.js` cross-checks US
   equity legs against the official bitget-mcp-server.
2. **Reason** — the LLM receives the full portfolio state (NAV, cash, drawdown, holdings with
   24h moves, live regime) + overnight perception, and returns `{trigger, rationale, orders}`
   as JSON. `sanitizeDecision` validates every order leg.
3. **Risk-gate** — `risk.js: planOrders` runs *first and always*: drawdown circuit breaker
   (10% day / 5% night), kill-switch, order-size cap (15% NAV), single-asset / aggregate
   crypto / aggregate rToken concentration caps, night-mode gross exposure limit, and
   Fear-regime rotation (SELL-before-BUY so rotation self-funds).
4. **Two-model audit** — a second reviewer criticises the **complete plan** (risk + LLM legs).
   Rejection drops only the LLM's discretionary legs; risk legs always survive. Fail-closed:
   if the LLM reviewer 429s, VIGIL falls back to the deterministic auditor (no key needed)
   and flags the fallback in the logged reason.
5. **Execute** — cash-correct ledger at live prices (10bp fee + 2bp slippage, cost basis →
   realized P&L). In `VIGIL_EXEC=bitget`, crypto legs route through real signed Bitget demo
   orders (`PAPTRADING:1`) and rTokens (halted in the demo) settle as labelled `paper-fallback`.
6. **Sign & log** — `signManifest` binds `{window, nonce, ts, navMicro, trigger, prices,
   orders, context, model, llm}` into a deterministic `VIGIL-<sha256>`, written to SQLite and
   to the committed paper-log CSV with the audit verdict.

## Execution economics (honest paper performance)

- NAV = cash + positions (cash-correct; buys are funded, never conjured).
- Every fill charges a **10bp taker fee + 2bp slippage**; cost basis tracked per position.
- SELLs are emitted before BUYs so rotation is cash-funded from proceeds.
- Realized P&L and win-rate are computed from **actual** closed SELLs, not assumptions.

## Data model (ledger tables — same schema on sqlite and Neon)

| Table | Purpose |
|---|---|
| `positions` | held qty (micro-units) + avg cost basis |
| `agent_state` | NAV, cash, realized P&L, status, nonce, breaker/kill flags |
| `decisions` | the signed log: ts, window, trigger, model, llm, nav, rationale, context_json, orders_json, mode, `review_verdict`, `review_rationale` |
| `orders` | executed legs: action, key, qty, usd, px, pnl, fee |
| `equity_curve` | nav + cash time series (Sharpe / max-DD / win-rate source) |
| `price_snapshots` | raw price feed snapshots per sweep |
| `alerts` | break-glass alert records |
| `sessions/` | isolated books per connected account (own ledger + sweep loop) |

## API surface

**Pages:** `/` (landing) · `/app` (+`?s=<id>`) · `/connect` · `/leaderboard` · `/night` · `/reports/latest`

**Data:** `/health` · `/api/state` · `/api/prices` · `/api/universe` · `/api/metrics`
(Sharpe/maxDD/win-rate/realized P&L) · `/api/equity` · `/api/backtest?days=` · `/api/decisions`
(each with `review_verdict`) · `/api/decision-log.csv` (incl. audit columns) · `/api/report` ·
`/api/night-timeline` · `/api/alerts` · `/api/leaderboard`

**US data (bitget-mcp-server):** `/api/us-market?symbol=` · `/api/us-history?symbol=&days=` ·
`/api/us-universe`

**Control:** `POST /api/run` · `GET /api/run?dry=1` (dryRun preview) · `POST /api/kill {on}`
· `GET /api/agent/stream` (SSE)

**Multi-session (Connect):** `GET/POST /api/sessions` · `GET /api/sessions/:id/{state,decisions,
metrics,alerts,timeline,log.csv}` · `POST /api/sessions/:id/{run,kill}` (owner-key header)

## Test suite (35 tests)

Engine valuation & signed manifests · risk caps & night-mode breaker · Fear-regime rotation ·
cash-funded buys (no overdraft) · fee/slippage settlement · sell-proceeds rotation · two-model
audit end-to-end (reject oversize plan / pass conservative plan) · deterministic auditor
rules · `usTickerFor` mapping · `usQuote` + `usHistory` against bitget-mcp-server ·
**dryRun previews without writing the ledger** · equity-curve analytics · decision log.

## Honest status

- **Live decision-maker:** Bitget Qwen `qwen3.8-max` (`VIGIL_LLM=qwen`, sponsor endpoint)
  recorded in the log as `qwen3.8-max @ bitget-qwen`. Pre-key, the seam ran Gemini 3.6 Flash
  as a drop-in; the log records whichever was wired.
- **Live data:** rToken + crypto prices (Bitget public API), US quotes (bitget-mcp-server),
  news/macro/Fear&Greed (bitget-signal MCP + fallbacks) — all real, moving.
- **Execution:** paper ledger at live prices (fees + slippage); a real Bitget demo-venue route
  (`VIGIL_EXEC=bitget`, `PAPTRADING:1`) is present and was verified to fill BTC/ETH.
- **Ledger persistence (Neon):** on the deployed service `VIGIL_DATABASE_URL` points at a
  Neon Postgres database. The flagship ledger lives in the `vigil` schema and every Connect
  session in its own `vigil_session_<id>` schema — fully schema-qualified queries (Neon's
  pooler does not persist `search_path`). The deployed ledger therefore **survives redeploys**
  (no more free-tier reset): the full multi-hundred-decision history is served live at
  `/api/*`. `src/db.js` dispatches to `src/db-pg.js` (async) or `src/db-sqlite.js` (sync);
  tests + local runs default to sqlite.
- **Committed evidence:** the paper-log (`docs/paper-log/vigil-decision-log.csv`) still records
  every signed decision with its audit verdict; refreshed by cron.

*Not financial advice. Novel-aggressive paper strategy; no capital at risk.*