// VIGIL — configuration
// An LLM-autonomous overnight cross-asset execution agent for Bitget AI Hackathon S2.
// Universe = tokenized US stocks (Bitget rToken: R<SYMBOL>USDT) + crypto (BTCUSDT/ETHUSDT).
//
// Decision-maker: Qwen (scored/agentic trading) via Bitget's hackathon endpoint.
// Perception: Bitget market-data MCP (datahub.noxiaohao.com/mcp) — news/macro/sentiment/tech.
// Execution: Bitget UTA v3 demo (paper) OR a local simulated paper ledger.

export const PROJECT = "vigil";
export const MICRO = 1_000_000n; // USD in micro-units in the ledger (1e6 = $1)
// Position quantities are stored in MICRO-UNITS of the asset (1e6 = 1 token) so the
// agent can hold fractions — required because BTC/ETH units are large ($78k/unit) and
// whole-unit sizing would zero out the crypto leg of a $10k book.
export const QTY_SCALE = 1_000_000n;
export const PRICE_DECIMALS = 8n; // Bitget tickers carry string prices; we parse to micro

// ---- seed portfolio (micro-USD) for the paper account ----
export const SEED_USD_MICRO = process.env.VIGIL_SEED_USD
  ? BigInt(Math.round(Number(process.env.VIGIL_SEED_USD) * 1e6))
  : 10_000_000_000n; // $10,000 paper starting equity

// Target cross-asset allocation (weights sum to 1e6 micro).
// Offense: tokenized tech/equities. Defense: a crypto risk-off / hedge bucket.
export const DEFAULT_TARGETS = {
  rtsla: 200_000n,   // Tesla token
  rnvda: 200_000n,   // NVIDIA token
  raapl: 150_000n,   // Apple token
  btc:   200_000n,   // Bitcoin (crypto leg)
  eth:   100_000n,   // Ethereum (crypto leg)
  rspy:   50_000n,   // S&P 500 ETF token (stable core)
  rqqq:  100_000n,   // Nasdaq 100 ETF token
};

// Hard per-position cap on any single holding (fraction of NAV) before the agent must trim.
export const MAX_SINGLE_ASSET_WEIGHT = 0.35;
// Max aggregate crypto (non-rToken) weight allowed — the agent keeps crypto in a bounded band.
export const MAX_CRYPTO_WEIGHT = 0.45;
// Max aggregate tokenized-equity weight.
export const MAX_RTOKEN_WEIGHT = 0.85;

// ---- risk control layer ----
export const MAX_DRAWDOWN = Number(process.env.VIGIL_MAX_DD || 0.10);   // 10% portfolio cap → circuit breaker
export const MAX_ORDER_PCT = Number(process.env.VIGIL_MAX_ORDER_PCT || 0.15); // single order ≤ 15% of NAV
export const MIN_TRADING_DAYS = 2;      // hold at least a modest history before sizing
export const KILL_SWITCH_FILE = process.env.VIGIL_KILL_SWITCH || "./kill.switch";

// ---- decision loop timing ----
// The overnight "hours humans sleep" scheduler: dense scans so the paper log is decision-rich.
export const SCAN_INTERVAL_MS = Number(process.env.VIGIL_SCAN_MS || 300_000); // 5 min
// Only act autonomously outside heartbeats? "hours humans sleep" = overnight/weekend emphasis,
// but for a decision-dense 7-day log we scan continuously and mark the window in each decision.
export const NIGHT_START_HOUR = 22; // 10pm local (Bitget trades ~UTC+8); the "asleep" window
export const NIGHT_END_HOUR = 6;    // 6am

// ---- execution mode ----
// paper   = local simulated paper ledger at live market price (honest, no Bitget creds needed)
// bitget  = route via Bitget UTA v3 demo/paper environment (requires VIGIL_BITGET_* creds)
export const EXECUTION_MODE = process.env.VIGIL_EXEC || "paper";

// ---- LLM seam ----
// qwen    = call Bitget Qwen (needs VIGIL_QWEN_API_KEY)
// stub    = deterministic rules (no network, used in tests + fallback)
export const LLM_MODE = process.env.VIGIL_LLM || "stub";
export const QWEN_BASE_URL = process.env.VIGIL_QWEN_BASE || "https://hackathon.bitgetops.com/v1";
export const QWEN_MODEL = process.env.VIGIL_QWEN_MODEL || "qwen3.8-max";

// ---- sources ----
export const BITGET_TICKERS_URL = "https://api.bitget.com/api/v2/spot/market/tickers?productType=spot";
export const DATDHUB_MCP_URL = process.env.VIGIL_MCP_URL || "https://datahub.noxiaohao.com/mcp";

// Curated tradeable universe. `bitget: 'TSLA'` means symbol RTSLAUSDT on Bitget; `crypto: true`
// means the raw BTCUSDT pair. We resolve to the live exact symbol at boot from the ticker feed.
export const UNIVERSE = [
  { key: "rtsla", name: "Tesla",         bitget: "TSLA",  asset: "equity" },
  { key: "rnvda", name: "NVIDIA",        bitget: "NVDA",  asset: "equity" },
  { key: "raapl", name: "Apple",         bitget: "AAPL",  asset: "equity" },
  { key: "rspy",  name: "S&P 500 ETF",   bitget: "SPY",   asset: "index"  },
  { key: "rqqq",  name: "Nasdaq 100 ETF",bitget: "QQQ",   asset: "index"  },
  { key: "rmeta", name: "Meta",          bitget: "META",  asset: "equity" },
  { key: "ramzn", name: "Amazon",        bitget: "AMZN",  asset: "equity" },
  { key: "rgoogl",name: "Alphabet",      bitget: "GOOGL", asset: "equity" },
  { key: "rmstr", name: "MicroStrategy", bitget: "MSTR",  asset: "equity" },
  { key: "rcoin", name: "Coinbase",      bitget: "COIN",  asset: "crypto-adjacent" },
  { key: "btc",   name: "Bitcoin",       crypto: "BTCUSDT", asset: "crypto" },
  { key: "eth",   name: "Ethereum",      crypto: "ETHUSDT", asset: "crypto" },
];

// ---- execution economics (honest paper performance: brief demands fee + slippage cost) ----
export const FEE_BPS = Number(process.env.VIGIL_FEE_BPS || 10);         // taker fee 10bp each side
export const SLIPPAGE_BPS = Number(process.env.VIGIL_SLIPPAGE_BPS || 2);// 2bp market-slippage each side

// ---- night-mode ("hours humans sleep"): tighten risk + bias to defense after hours ----
export const NIGHT_DD_CAP = Number(process.env.VIGIL_NIGHT_DD || 0.05); // effective breaker 5% at night
export const NIGHT_MAX_GROSS = Number(process.env.VIGIL_NIGHT_GROSS || 0.70); // cap gross exposure at night

// ---- cross-asset regime (Fear & Greed → risk-on/off) ----
export const REGIME_FEAR = Number(process.env.VIGIL_REGIME_FEAR || 35); // F&G < 35 → defensive tilt
export const REGIME_GREED = Number(process.env.VIGIL_REGIME_GREED || 70);// F&G > 70 → risk-on tilt
export const DEFENSIVE_KEYS = ["rspy", "rqqq"];                          // defensive index base to rotate into

// ---- derived ----
export const isCrypto = (key) => (UNIVERSE.find((x) => x.key === key))?.crypto ? true : false;
export const isDefensive = (key) => DEFENSIVE_KEYS.includes(key);

// ---- misc ----
export function cryptoKeys() { return UNIVERSE.filter((x) => x.crypto).map((x) => x.key); }
export function equityKeys() { return UNIVERSE.filter((x) => !x.crypto).map((x) => x.key); }