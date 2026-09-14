// VIGIL — paper executor. Routes the decision's orders into the SQLite ledger at the
// live market price, with a real CASH ledger + fee + slippage + cost basis + realized P&L
// so paper performance is honest (the brief demands fee & slippage costs). BUY cannot
// conjure money: every buy is cash-funded (using proceeds of sells in the same batch).
// EXECUTION_MODE=bitget routes the identical logic behind the same seam via the UTA v3 demo.
import { getPositions, setPosition, getCash, setCash, addRealized } from "./db.js";
import { signManifest, decisionId } from "./engine.js";
import { EXECUTION_MODE, QTY_SCALE, FEE_BPS, SLIPPAGE_BPS } from "./config.js";

const FEE = BigInt(FEE_BPS);        // bps
const SLIP = BigInt(SLIPPAGE_BPS);  // bps
const TENK = 10_000n;

export function executeOrders(db, { orders, trigger, rationale, window, model, llm, prices, navMicro, context }) {
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

  const nonce = decisionId(db);
  const manifest = signManifest({ window, nonce, ts: Date.now(), navMicro, trigger, prices, orders: executed, model, llm, context });
  return { executed, manifest, nonce, mode: EXECUTION_MODE };
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