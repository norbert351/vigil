# VIGIL — Bitget AI Hackathon S2 · Submission draft

**Track:** Agentic Trading · **Sub-theme:** Cross-Asset Execution Agent
**Repo:** https://github.com/norbert351/vigil · **Deadline:** 9/21 (UTC+8)

---

## 1. Mandatory X post (must include `#BitgetHackathon` + `@Bitget_AI`)

> Tokenized US stocks don't sleep — neither does VIGIL 🤖🌙
>
> An LLM-autonomous **cross-asset execution agent** on @Bitget_AI: while you sleep, it
> senses macro/news/sentiment + live Bitget rToken & crypto prices, decides on its own,
> and rebalances/hedges a mixed portfolio with hard risk caps. Every move is signed
> `VIGIL-<sha256>` and logged as a verifiable paper-trading record.
>
> Qwen is the decision-maker. Bitget MCP is its eyes. The risk layer is its spine.
>
> 7×24 US-stock tokens → this epoch's sleep-gap problem → an agent that works the hours
> humans sleep. Watch it run → [repo | live link]
>
> #BitgetHackathon @Bitget_AI @Alibaba_Qwen #AgenticTrading

---

## 2. Google Form — Project Description (6 parts; judges weigh 1–3 most)

### Part 1 · Thesis (highest weight)
Tokenized US stocks (Bitget **rToken**) trade 7×24, but the humans who manage them do
not — over the 2026 Labor Day weekend the NYSE was shut **89.5h** while tokenized
stocks printed **$1.41B** of continuous volume, with nobody at the keyboard to rebalance
or hedge as macro news broke at 2am. VIGIL is an **LLM-autonomous cross-asset execution
agent** that closes that sleep-gap: each ~5-min cycle it **senses** live rToken + crypto
prices and overnight context (news, macro, Fear & Greed via Bitget's market-data MCP),
**reasons** with the LLM (Qwen `qwen3.8-max`, the decision-maker), **risk-gates** hard
(circuit breaker, kill-switch, order-size + concentration caps), **executes** a paper
ledger at the live market price, and **signs every decision** `VIGIL-<sha256>` bound to
{window, nonce, ts, nav, trigger, prices, orders}. When humans sleep, the agent is
explicitly *made for* those hours — cross-market allocation and hedging between rToken
equities and crypto on macro shocks, without needing a human to wake up.

### Part 2 · Target user & product value
**Primary user:** a non-US retail/institutional trader holding a mixed Bitget rToken +
crypto book (e.g. tokenized TSLA/NVDA + BTC/ETH) who cannot (or will not) monitor
overnight/weekend macro risk. **Trigger moment:** markets close in their timezone, or a
US weekend where macro data (CPI/Fed/geopolitics) lands while the rToken market keeps
trading. **Why it keeps them:** continuous autonomous monitoring, hard risk caps
(funds can't be over-concentrated or over-drawn), and a full signed audit trail of every
decision — sensable risk control, not a black box. **Who it is NOT for:** high-frequency
intraday scalpers (the agent is a defensive manager, not a momentum bot) or anyone who
wants zero-touch fully-automated leverage (the agent is risk-capped by design).

### Part 3 · Validation data & key metrics
**Observed (live, during competition, paper):** agent seeded $10k across 7 assets (cash-correct:
NAV = cash + positions, fees + slippage charged) and autonomously senses on a ~5-min cadence;
every decision is a timestamped, signed log row (`GET /api/decision-log.csv`) — a running 7-day
paper-trading record starting **Sep 14**. **Metrics are computed live at `GET /api/metrics`**
(Sharpe from the `equity_curve`, max drawdown, win rate + realized P&L from closed SELLs, trade
count) — the exact numbers the judge can pull from the running agent. **Targets (labeled):**
>0.5 Sharpe, max-drawdown <8% (the breaker enforces 10% by day, 5% at night), a decision-dense
log (>200 logged cycles), and documented rotation trades when Fear-regime / target-drift fires.
**How effectiveness is proven:** the signed manifest binds the context the agent saw
(window, hour, NAV, cash, drawdown, Fear & Greed, headlines) — a judge can replay and audit
every decision, and the live dashboard (SSE) shows it still running.

### Part 4 · Progress
**Built:** full zero-dep Node agent — live Bitget rToken+crypto pricing (12-symbol
universe), overnight perception (Bitget market-data MCP + RSS + Fear&Greed fallbacks),
a **LIVE LLM decision-maker** (OpenAI-compatible seam; running today on Gemini 3.6 Flash
with Bitget **Qwen `qwen3.8-max`** as a one-var sponsor swap), hard risk layer
(night-mode + Fear-regime rotation), cash-correct paper executor (fees + slippage),
signed-manifest ledger with bound context, equity-curve + Sharpe/max-DD/win-rate
analytics, HTTP/SSE dashboard, **15/15 tests green**, public repo, fresh clone verified
to boot. **Not yet:** real-venue (Bitget Demo/Agentic) execution — the `EXECUTION_MODE=bitget`
seam is in place, pending a Demo API key — and the Qwen sponsor key (pending KYC credit).
**Frameworks/APIs:** node:sqlite, node:http, Bitget UTA v3 public market data, Bitget
Agent Hub / market-data MCP, an OpenAI-compatible LLM endpoint.

### Part 5 · Deliverables (in Submission Materials Link)
- Public **GitHub repo** (code, tests, render.yaml, README)
- **Live demo / dashboard** URL (deployed) + SSE agent stream
- **Paper-trading log**: `docs/paper-log/vigil-decision-log.csv` (committed, dated)
- README with architecture + honest status

### Part 6 · Take on AI Trading (optional)
The defensible autonomous agent is the hard 20%: the LLM should propose, the risk layer
should dispose. VIGIL treats the LLM as the decision-maker but never lets it move the
book outside hard caps or an armed drawdown breaker — and neutralizes the black-box
objection by signing every move into an auditable manifest.

---

## 3. Role of the LLM in Your Project
A **real LLM is the decision-maker** (not an assistant). It runs through an
OpenAI-compatible seam (`src/llm.js`): it receives the live portfolio state (NAV, cash,
drawdown, holdings with 24h moves) plus the overnight perception (Fear & Greed, top
headlines), and returns `{trigger, rationale, orders}`. The hard risk layer then gates
and sizes those orders. The agent is running today on **Gemini 3.6 Flash** (`VIGIL_LLM=live`)
and records `model: gemini-3.6-flash @ …` in its signed decision log with genuine
model-written rationales — verifiable live at `GET /api/decisions`. Bitget **Qwen
`qwen3.8-max`** (sponsor endpoint `hackathon.bitgetops.com`) is a one-var swap
(`VIGIL_LLM=qwen` + the KYC-provisioned key) on the identical seam and loop; the log
will then record the Qwen model id and provider.