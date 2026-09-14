// VIGIL — paper executor. Routes the decision's orders into the SQLite ledger at the
// live market price. EXECUTION_MODE=paper (default; no Bitget creds needed, honest
// label on every artifact). A Bitget UTA v3 demo execution is wired behind the same
// seam (EXECUTION_MODE=bitget) so the identical decision logic can later go live.
import { setPosition, clearPositions, getPositions, setAgentState, saveSnapshot } from "./db.js";
import { signManifest, decisionId } from "./engine.js";
import { EXECUTION_MODE, QTY_SCALE } from "./config.js";

// Apply orders to the ledger. orders: [{action,key,usdMicro,reason}]. prices: market map.
// Returns executed order detail with real qty at live price. Throws on oversell.
export function executeOrders(db, { orders, trigger, rationale, window, model, llm, prices, navMicro }) {
  const pos = getPositions(db);
  // market only for priced names
  const qtyFor = (key, usdMicro) => {
    const px = prices[key]?.lastMicro;
    if (px == null || px <= 0) return 0n;
    return (BigInt(usdMicro) * QTY_SCALE) / BigInt(px); // micro-units of the asset
  };

  const executed = [];
  const cl = { ...pos }; // flat { key: BigInt qty micro-units }
  const pxOf = (k) => BigInt(prices[k]?.lastMicro || 0);
  const usdOf = (k, qtyMicro) => (qtyMicro * pxOf(k)) / QTY_SCALE;
  for (const o of orders) {
    const usd = Math.max(0, Number(o.usdMicro || 0));
    if (usd < 100_000) continue; // skip micro-dust (< $0.10)
    if (o.action === "SELL") {
      const held = cl[o.key] || 0n;
      const qty = qtyFor(o.key, usd);
      if (qty <= 0n) continue;
      const q = qty > held ? held : qty; // never oversell
      if (q <= 0n) continue;
      cl[o.key] = held - q;
      executed.push({ action: "SELL", key: o.key, qtyMicro: q, usdMicro: usdOf(o.key, q), pxMicro: pxOf(o.key), detail: o.reason || "manual" });
    } else if (o.action === "BUY" || o.action === "HEDGE") {
      const qty = qtyFor(o.key, usd);
      if (qty <= 0n) continue;
      cl[o.key] = (cl[o.key] || 0n) + qty;
      executed.push({ action: o.action === "HEDGE" ? "HEDGE" : "BUY", key: o.key, qtyMicro: qty, usdMicro: usdOf(o.key, qty), pxMicro: pxOf(o.key), detail: o.reason || "manual" });
    } else if (o.action === "LIQUIDATE") {
      const held = cl[o.key] || 0n;
      if (held > 0n) {
        cl[o.key] = 0n;
        executed.push({ action: "LIQUIDATE", key: o.key, qtyMicro: -held, usdMicro: -usdOf(o.key, held), pxMicro: pxOf(o.key), detail: o.reason || "breaker" });
      }
    }
  }

  // write flat positions
  for (const [key, qty] of Object.entries(cl)) setPosition(db, key, qty);

  // signed manifest for this decision (+ insert the paper-trading log row)
  const nonce = decisionId(db);
  const manifest = signManifest({ window, nonce, ts: Date.now(), navMicro, trigger, prices, orders: executed, model, llm });
  // decisions + orders rows are inserted by logDecision in agent.js (needs the seq back)
  return { executed, manifest, nonce, mode: EXECUTION_MODE };
}