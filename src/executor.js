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
import { defaultVenue, venueSymbol } from "./venue.js";

const FEE = BigInt(FEE_BPS);        // bps
const SLIP = BigInt(SLIPPAGE_BPS);  // bps
const TENK = 10_000n;

// ---- Bitget venue route (EXECUTION_MODE=bitget) ----
// Places real (virtual-funds) market orders, then re-syncs the ledger so NAV,
// positions and cash match venue truth. Fees come from venue fills.
// Re-sync the local ledger to venue truth: positions from actual holdings,
// cash = USDT available. Called before decisions in bitget mode (the venue IS
// the account — no paper seed) and after execution.
export async function syncLedgerFromVenue(db, prices, venue) {
  const v = venue || defaultVenue;
  const bal = await v.getBalances();
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
  for (const key of Object.keys(await getPositions(db))) {
    if (!map[key]) await setPosition(db, key, 0n, null);
  }
  for (const [k, v] of Object.entries(map)) if (v.qty > 0n) await setPosition(db, k, v.qty, v.avgCost);
  const usdt = await v.usdtAvailable();
  await setCash(db, BigInt(Math.round(usdt * 1e6)));
  return map;
}

// Bitget demo codes that mean "this venue cannot trade that symbol":
//   40034 = symbol does not exist in the demo environment
//   70227 = symbol exists but this account is not permitted to trade it
// Both are handled by falling back to a clearly-labelled paper fill for that order.
const VENUE_UNSUPPORTED_CODES = new Set(["40034", "70227"]);

function parseFeeMicro(fill, pxMicro) {
  // feeDetail is a JSON string like {"BTC":{"totalFee":-6.5E-8}} — fee paid in base coin.
  try {
    const d = typeof fill?.feeDetail === "string" ? JSON.parse(fill.feeDetail) : fill?.feeDetail;
    if (!d) return 0n;
    for (const [coin, v] of Object.entries(d)) {
      if (coin === "newFees") continue;
      const fee = Math.abs(Number(v?.totalFee || 0));
      if (!fee) continue;
      const usd = coin === "USDT" || coin === "USDC" ? fee : fee * (Number(pxMicro) / 1e6);
      return BigInt(Math.round(usd * 1e6));
    }
  } catch { /* ignore */ }
  return 0n;
}

// Single-order paper fill against a wallet { pos, cash } — used only for symbols the
// demo venue cannot trade (rTokens). Same fee + slippage + cost-basis semantics as the
// full paper route, so the ledger stays internally consistent.
function paperFillOne(o, prices, wallet) {
  const FEEB = FEE, SLIPB = SLIP, USDT = TENK;
  const px = BigInt(prices[o.key]?.lastMicro || 0);
  if (px <= 0n) return { error: "no price for paper fallback" };
  const usd = Math.max(0, Number(o.usdMicro || 0));
  if (usd < 100_000) return null;
  const level = (buy) => (buy ? px + (px * SLIPB) / USDT : px - (px * SLIPB) / USDT);

  if (o.action === "SELL" || o.action === "LIQUIDATE") {
    const held = wallet.pos[o.key]?.qty || 0n;
    if (held <= 0n) return null;
    const lvl = level(false);
    let qty = (BigInt(usd) * QTY_SCALE) / lvl;
    if (o.action === "LIQUIDATE") qty = held;
    if (qty > held) qty = held;
    if (qty <= 0n) return null;
    const notional = (qty * lvl) / QTY_SCALE;
    const proceeds = notional - (notional * FEEB) / USDT;
    const fee = (notional * FEEB) / USDT;
    const avg = wallet.pos[o.key]?.avgCost;
    const pnl = avg != null ? ((lvl - avg) * qty) / QTY_SCALE : 0n;
    wallet.pos[o.key] = { qty: held - qty, avgCost: held - qty === 0n ? null : wallet.pos[o.key].avgCost };
    wallet.cash += proceeds;
    return { action: o.action, key: o.key, qtyMicro: qty, usdMicro: notional, pxMicro: lvl, pnlMicro: pnl, feeMicro: fee };
  }
  if (o.action === "BUY" || o.action === "HEDGE") {
    const lvl = level(true);
    const maxNotional = (wallet.cash * USDT) / (USDT + FEEB);
    const want = BigInt(usd);
    const target = want < maxNotional ? want : maxNotional;
    if (target <= 0n) return null;
    const qty = (target * QTY_SCALE) / lvl;
    if (qty <= 0n) return null;
    const notional = (qty * lvl) / QTY_SCALE;
    const cost = notional + (notional * FEEB) / USDT;
    if (cost > wallet.cash) return null;
    const fee = (notional * FEEB) / USDT;
    const prev = wallet.pos[o.key] || { qty: 0n, avgCost: null };
    const newQty = prev.qty + qty;
    // avgCost is micro-USD per 1 base unit (matches px_micro so (lvl - avg) is dimensionally right)
    let newAvg;
    if (prev.avgCost != null && prev.qty > 0n) newAvg = (prev.qty * prev.avgCost + cost * QTY_SCALE) / newQty;
    else newAvg = (cost * QTY_SCALE) / qty;
    wallet.pos[o.key] = { qty: newQty, avgCost: newAvg };
    wallet.cash -= cost;
    return { action: o.action === "HEDGE" ? "HEDGE" : "BUY", key: o.key, qtyMicro: qty, usdMicro: notional, pxMicro: lvl, pnlMicro: 0n, feeMicro: fee };
  }
  return null;
}

async function executeOnVenue(db, { orders, prices, venue }) {
  const v = venue || defaultVenue;
  const { getBalances, usdtAvailable, placeMarketOrder, waitForFill, toSizeUsd, toSizeBase, venueTradable, floorTo, roundTo } = v;
  const executed = [];
  if (!v.configured()) {
    throw new Error("venue execution requested but venue creds missing for this client");
  }
  // wallet = local ledger view; venue-supported fills are overwritten from venue truth after the batch
  const wallet = { pos: await getPositions(db), cash: await getCash(db) };
  const paperKeys = new Set();
  const startCash = wallet.cash;
  let venueFilled = 0, paperFilled = 0;

  for (const o of orders) {
    const usd = Math.max(0, Number(o.usdMicro || 0));
    if (usd < 100_000) continue; // dust guard, mirrors paper path
    if (!venueSymbol(o.key)) { executed.push({ action: o.action, key: o.key, error: "no venue symbol", skip: true }); continue; }

    // Ask the venue what it can actually trade BEFORE placing: the demo environment
    // halts tokenized stocks (rToken) and blocks region-restricted symbols, so those
    // legs go straight to a labelled paper fill rather than a wasted rejected order.
    const cap = await venueTradable(o.key);
    if (!cap.ok && !cap.unknown) {
      const fallback = paperFillOne(o, prices, wallet);
      if (fallback && !fallback.error) {
        paperKeys.add(o.key);
        paperFilled++;
        executed.push({ ...fallback, venue: false, detail: `paper-fallback (${cap.reason})` });
      } else {
        executed.push({ action: o.action, key: o.key, skip: true, venue: false, detail: `venue unsupported (${cap.reason}) — no paper fill` });
      }
      continue;
    }

    try {
      let size, side;
      if (o.action === "BUY" || o.action === "HEDGE") {
        side = "buy";
        if (cap.meta && usd / 1e6 < cap.meta.minTradeUSDT) {
          executed.push({ action: o.action, key: o.key, skip: true, detail: `below venue min ${cap.meta.minTradeUSDT} USDT` });
          continue;
        }
        size = cap.meta ? roundTo(Number(toSizeUsd(usd)), Math.min(cap.meta.quotePrecision, 2)) : toSizeUsd(usd); // market buy spends quote
      } else {
        side = "sell";
        const px = prices[o.key]?.lastMicro;
        if (px == null || Number(px) <= 0) { executed.push({ action: o.action, key: o.key, error: "no price", skip: true }); continue; }
        if (o.action === "LIQUIDATE") {
          const bal = await getBalances();
          const baseCoin = venueSymbol(o.key).replace(/USDT$/, "");
          const held = Number(bal[baseCoin]?.available || 0);
          if (held <= 0) { executed.push({ action: o.action, key: o.key, qtyMicro: 0n, usdMicro: 0n, skip: true, detail: "nothing held on venue" }); continue; }
          size = cap.meta ? floorTo(held, cap.meta.quantityPrecision) : held.toFixed(8);
        } else {
          const qtyBase = toSizeBase(o.usdMicro, px);
          if (!qtyBase || Number(qtyBase) <= 0) continue;
          // floor to the venue's base precision — over-precision is rejected outright
          size = cap.meta ? floorTo(qtyBase, cap.meta.quantityPrecision) : qtyBase;
        }
        if (!size || Number(size) <= 0) { executed.push({ action: o.action, key: o.key, skip: true, detail: "size rounds to zero at venue precision" }); continue; }
        if (cap.meta && Number(size) * (Number(px) / 1e6) < cap.meta.minTradeUSDT) {
          executed.push({ action: o.action, key: o.key, skip: true, detail: `below venue min ${cap.meta.minTradeUSDT} USDT` });
          continue;
        }
      }
      const placed = await placeMarketOrder({ key: o.key, side, size });
      let fill = null;
      if (placed.orderId) {
        try { fill = await waitForFill(placed.orderId); } catch { /* non-fatal */ }
      }
      const pxMicro = fill?.priceAvg ? Math.round(Number(fill.priceAvg) * 1e6) : null;
      const qtyMicro = fill?.baseVolume ? BigInt(Math.round(Number(fill.baseVolume) * 1e6)) : null;
      const usdMicro = fill?.quoteVolume ? BigInt(Math.round(Number(fill.quoteVolume) * 1e6)) : BigInt(Math.round(usd));
      executed.push({
        action: o.action, key: o.key, side, size, orderId: placed.orderId, venueStatus: fill?.status || placed.status,
        qtyMicro, usdMicro, pxMicro, feeMicro: parseFeeMicro(fill, pxMicro),
        venue: true, detail: `venue:${placed.orderId}`,
      });
      venueFilled++;
    } catch (e) {
      if (VENUE_UNSUPPORTED_CODES.has(e.code)) {
        // Venue cannot trade this symbol (rTokens in demo) — simulate that leg on the ledger,
        // explicitly labelled so the decision log never presents it as a venue fill.
        const entry = paperFillOne(o, prices, wallet);
        if (entry && !entry.error) {
          paperKeys.add(o.key);
          paperFilled++;
          executed.push({ ...entry, venue: false, detail: `paper-fallback (venue ${e.code})` });
        } else {
          executed.push({ action: o.action, key: o.key, skip: true, venue: false, detail: `venue unsupported (${e.code}) — no paper fill` });
        }
      } else {
        executed.push({ action: o.action, key: o.key, error: String(e.message || e), skip: true, detail: `venue error: ${e.venueMsg || e.message || e}` });
      }
    }
  }

  // Persist paper-fallback legs (venue-unsupported symbols) into the ledger.
  for (const key of paperKeys) {
    const p = wallet.pos[key];
    if (p) await setPosition(db, key, p.qty, p.avgCost);
  }
  const venueErrors = executed.filter((e) => e.error).length;
  // Re-sync venue-traded holdings + cash to venue truth, then apply the paper-leg cash delta.
  try {
    const bal = await getBalances();
    for (const key of Object.keys(prices)) {
      if (paperKeys.has(key)) continue; // simulated leg — keep the ledger's own fill
      const sym = venueSymbol(key);
      if (!sym) continue;
      const baseCoin = sym.replace(/USDT$/, "");
      const held = Number(bal[baseCoin]?.available || 0);
      const px = Number(prices[key]?.lastMicro || 0) / 1e6;
      if (held > 0 && px > 0) await setPosition(db, key, BigInt(Math.round(held * 1e6)), BigInt(Math.round(px * 1e6)));
      else if (!paperKeys.has(key)) await setPosition(db, key, 0n, null);
    }
    const usdt = await usdtAvailable();
    const paperDelta = wallet.cash - startCash; // cash effect of simulated legs
    await setCash(db, BigInt(Math.round(usdt * 1e6)) + paperDelta);
  } catch (e) { /* ledger sync non-fatal */ }
  return { executed, venueFilled, paperFilled, venueErrors };
}

export async function executeOrders(db, { orders, trigger, rationale, window, model, llm, prices, navMicro, context, venue, execMode }) {
  const mode = execMode || EXECUTION_MODE;
  const isVenue = mode === "bitget";
  let executed;
  if (isVenue) {
    const r = await executeOnVenue(db, { orders, prices, venue });
    executed = r.executed;
    globalThis.__vigilVenueStats = { venueFilled: r.venueFilled, paperFilled: r.paperFilled, venueErrors: r.venueErrors || 0 };
  } else {
    executed = await executePaper(db, { orders, prices });
  }

  const nonce = await decisionId(db);
  const manifest = signManifest({ window, nonce, ts: Date.now(), navMicro, trigger, prices, orders: executed, model, llm, context });
  return { executed, manifest, nonce, mode };
}

// ---- paper route (default) ----
async function executePaper(db, { orders, prices }) {
  const pos = await getPositions(db); // { key: { qty, avgCost } }
  let cash = await getCash(db);

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
      if (pnl !== 0n) await addRealized(db, pnl);
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
  for (const [key, p] of Object.entries(pos)) await setPosition(db, key, p.qty, p.avgCost);
  await setCash(db, cash);

  return executed;
}

function applyBuy(pos, key, qty, costUsdMicro) {
  const prev = pos[key] || { qty: 0n, avgCost: null };
  const newQty = prev.qty + qty;
  // avgCost is micro-USD per 1 base unit (matches px_micro so (lvl - avg) is dimensionally right)
  let newAvg;
  if (prev.avgCost != null && prev.qty > 0n) {
    newAvg = (prev.qty * prev.avgCost + costUsdMicro * QTY_SCALE) / newQty;
  } else {
    newAvg = (costUsdMicro * QTY_SCALE) / qty;
  }
  pos[key] = { qty: newQty, avgCost: newAvg };
}