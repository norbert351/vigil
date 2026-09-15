// VIGIL — order executor. Routes the decision's orders into the SQLite ledger at the
// live market price, with a real CASH ledger + fee + slippage + cost basis + realized P&L
// so paper performance is honest (the brief demands fee & slippage costs). BUY cannot
// conjure money: every buy is cash-funded (using proceeds of sells in the same batch).
// EXECUTION_MODE=bitget routes the same decisions to the Bitget paper-trading venue
// (PAPTRADING demo environment) via signed UTA v3 spot orders, then re-syncs the ledger
// with venue truth (fills, fees, balances).
import { getPositions, setPosition, getCash, setCash, addRealized } from "./db.js";
import { signManifest, decisionId } from "./engine.js";
import { EXECUTION_MODE, QTY_SCALE, FEE_BPS, SLIPPAGE_BPS } from "./config.js";
import { venueConfigured, venueSymbol, getBalances, usdtAvailable, placeMarketOrder, getOrderInfo, toSizeUsd, toSizeBase } from "./venue.js";

const FEE = BigInt(FEE_BPS);        // bps
const SLIP = BigInt(SLIPPAGE_BPS);  // bps
const TENK = 10_000n;

// ---- Bitget venue route (EXECUTION_MODE=bitget) ----
// Places real (virtual-funds) market orders, then re-syncs the ledger so NAV,
// positions and cash match venue truth. Fees come from venue fills.
// Re-sync the local ledger to venue truth: positions from actual holdings,
// cash = USDT available. Called before decisions in bitget mode (the venue IS
// the account — no paper seed) and after execution.
export async function syncLedgerFromVenue(db, prices) {
  const bal = await getBalances();
  const map = {};
  for (const key of Object.keys(prices || {})) {
    const sym = venueSymbol(key);
    if (!sym) continue;
    const baseCoin = sym.replace(/USDT$/, "");
    const held = Number(bal[baseCoin]?.available || 0);
    if (held > 0) {
      const px = Number(prices[key]?.lastMicro || 0) / 1e6;
      if (px > 0) {
        // cost basis approximated from current price on first sync; improves after real fills
        map[key] = { qty: BigInt(Math.round(held * 1e6)), avgCost: BigInt(Math.round(px * 1e6)) };
      }
    }
  }
  // clear stale paper positions — venue holdings are the source of truth
  for (const r of db.prepare("SELECT key FROM positions").all()) {
    if (!map[r.key]) setPosition(db, r.key, 0n, null);
  }
  for (const [k, v] of Object.entries(map)) if (v.qty > 0n) setPosition(db, k, v.qty, v.avgCost);
  const usdt = await usdtAvailable();
  setCash(db, BigInt(Math.round(usdt * 1e6)));
  return map;
}

async function executeOnVenue(db, { orders, prices }) {
  const executed = [];
  if (!venueConfigured()) {
    throw new Error("VIGIL_EXEC=bitget but venue creds missing (VIGIL_BITGET_API_KEY/SECRET/PASSPHRASE)");
  }
  for (const o of orders) {
    const usd = Math.max(0, Number(o.usdMicro || 0));
    if (usd < 100_000) continue; // dust guard, mirrors paper path
    const sym = venueSymbol(o.key);
    if (!sym) { executed.push({ action: o.action, key: o.key, error: `no venue symbol`, skip: true }); continue; }
    try {
      let size, side;
      if (o.action === "BUY" || o.action === "HEDGE") {
        // spend at most `usd` of quote (USDT); venue validates balance
        side = "buy";
        size = toSizeUsd(usd);
      } else {
        // sell / liquidate: convert micro-USD notional to base qty at live price
        side = "sell";
        const px = prices[o.key]?.lastMicro;
        if (px == null || Number(px) <= 0) { executed.push({ action: o.action, key: o.key, error: "no price", skip: true }); continue; }
        if (o.action === "LIQUIDATE") {
          // liquidate the whole position: query venue holdings for this symbol
          const sym2 = venueSymbol(o.key);
          const bal = await getBalances();
          const baseCoin = sym2.replace(/USDT$/, "");
          const held = Number(bal[baseCoin]?.available || 0);
          if (held <= 0) { executed.push({ action: o.action, key: o.key, qtyMicro: 0n, usdMicro: 0n, skip: true, detail: "nothing held on venue" }); continue; }
          size = held.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
        } else {
          const qtyBase = toSizeBase(o.usdMicro, px);
          if (!qtyBase || Number(qtyBase) <= 0) continue;
          size = qtyBase;
        }
      }
      const placed = await placeMarketOrder({ key: o.key, side, size });
      // pull fill info (market orders fill immediately)
      let fill = null;
      if (placed.orderId) {
        try { fill = await getOrderInfo(placed.orderId); } catch { /* non-fatal */ }
      }
      executed.push({
        action: o.action, key: o.key, side, size, orderId: placed.orderId, venueStatus: placed.status,
        fillUsd: fill?.priceAvg ? (Number(fill.priceAvg) * Number(fill.baseVolume || 0)) : null,
        fillPriceMicro: fill?.priceAvg ? Math.round(Number(fill.priceAvg) * 1e6) : null,
        feeMicro: fill?.feeDetail ? Math.round(Number(fill.feeDetail.replace(/[^0-9.\-]/g, "")) * 1e6) : null,
        detail: `venue:${placed.orderId}`,
      });
    } catch (e) {
      executed.push({ action: o.action, key: o.key, error: String(e.message || e), skip: true });
    }
  }
  // Re-sync ledger to venue truth: positions from actual holdings, cash = USDT available.
  try {
    const bal = await getBalances();
    const map = {};
    for (const key of Object.keys(prices)) {
      const sym = venueSymbol(key);
      if (!sym) continue;
      const baseCoin = sym.replace(/USDT$/, "");
      const held = Number(bal[baseCoin]?.available || 0);
      if (held > 0) {
        const px = Number(prices[key]?.lastMicro || 0) / 1e6;
        if (px > 0) map[key] = { qty: BigInt(Math.round(held * 1e6)), avgCost: BigInt(Math.round((held * px) / held / 1e6 * 1e6)) }; // keep cost basis simple
      }
    }
    for (const [k, v] of Object.entries(map)) if (v.qty > 0n) setPosition(db, k, v.qty, v.avgCost);
    const usdt = await usdtAvailable();
    setCash(db, BigInt(Math.round(usdt * 1e6)));
  } catch (e) { /* ledger sync non-fatal */ }
  return executed;
}

export async function executeOrders(db, { orders, trigger, rationale, window, model, llm, prices, navMicro, context }) {
  const isVenue = EXECUTION_MODE === "bitget";
  const executed = isVenue
    ? await executeOnVenue(db, { orders, prices })
    : executePaper(db, { orders, prices });

  const nonce = decisionId(db);
  const manifest = signManifest({ window, nonce, ts: Date.now(), navMicro, trigger, prices, orders: executed, model, llm, context });
  return { executed, manifest, nonce, mode: EXECUTION_MODE };
}

// ---- paper route (default) ----
function executePaper(db, { orders, prices }) {
  const pos = getPositions(db); // { key: { qty, avgCost } }
  let cash = getCash(db);

  const pxOf = (k) => BigInt(prices[k]?.lastMicro || 0);
  // effective fill = last price shifted by slippage (pay more on buy, get less on sell)
  const level = (k, buy) => {
    const px = pxOf(k);
    const adj = (px * SLIP) / TENK;
    return buy ? px + adj : px - adj;
  };
  const buyCost = (nMicro) => nMicro + (nMicro * FEE) / TENK;      // notional + taker fee
  const sellProceeds = (nMicro) => nMicro - (nMicro * FEE) / TENK; // notional - taker fee

  const executed = [];

  for (const o of orders) {
    const usd = Math.max(0, Number(o.usdMicro || 0));
    if (usd < 100_000) continue; // micro-dust (< $0.10)

    if (o.action === "SELL" || o.action === "LIQUIDATE") {
      const held = pos[o.key]?.qty || 0n;
      if (held <= 0n) continue;
      const lvl = level(o.key, false);
      let qty = (BigInt(usd) * QTY_SCALE) / lvl;
      if (o.action === "LIQUIDATE") qty = held;
      if (qty > held) qty = held;
      if (qty <= 0n) continue;
      const notional = (qty * lvl) / QTY_SCALE;
      const proceeds = sellProceeds(notional);
      const fee = (notional * FEE) / TENK;
      // realized P&L vs cost basis (avgCost = micro-usd per micro-unit)
      const avg = pos[o.key]?.avgCost;
      const pnl = avg != null ? ((lvl - avg) * qty) / QTY_SCALE : 0n;
      pos[o.key] = { ...pos[o.key], qty: held - qty, avgCost: held - qty === 0n ? null : pos[o.key].avgCost };
      cash += proceeds;
      if (pnl !== 0n) addRealized(db, pnl);
      executed.push({ action: o.action, key: o.key, qtyMicro: qty, usdMicro: notional, pxMicro: lvl, pnlMicro: pnl, feeMicro: fee, detail: o.reason || "manual" });
    } else if (o.action === "BUY" || o.action === "HEDGE") {
      const lvl = level(o.key, true);
      // max NOTIONAL (micro-USD) cash can fund after fee: notional*(1+fee) <= cash
      const maxNotional = (cash * TENK) / (TENK + FEE);
      const want = BigInt(usd);
      const targetNotional = want < maxNotional ? want : maxNotional;
      if (targetNotional <= 0n) continue;
      const qty = (targetNotional * QTY_SCALE) / lvl;
      if (qty <= 0n) continue;
      const notional = (qty * lvl) / QTY_SCALE;
      const cost = buyCost(notional);
      if (cost > cash) continue;
      const fee = (notional * FEE) / TENK;
      executed.push({ action: o.action === "HEDGE" ? "HEDGE" : "BUY", key: o.key, qtyMicro: qty, usdMicro: notional, pxMicro: lvl, pnlMicro: 0n, feeMicro: fee, detail: o.reason || "manual" });
      applyBuy(pos, o.key, qty, cost);
      cash -= cost;
    }
  }

  // write back positions (with cost basis) + cash
  for (const [key, p] of Object.entries(pos)) setPosition(db, key, p.qty, p.avgCost);
  setCash(db, cash);

  return executed;
}

function applyBuy(pos, key, qty, costUsdMicro) {
  const prev = pos[key] || { qty: 0n, avgCost: null };
  const newQty = prev.qty + qty;
  let newAvg = costUsdMicro / qty;
  if (prev.avgCost != null && prev.qty > 0n) {
    newAvg = (prev.qty * prev.avgCost + costUsdMicro) / newQty;
  }
  pos[key] = { qty: newQty, avgCost: newAvg };
}