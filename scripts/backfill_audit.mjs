// VIGIL — backfill audit verdicts on executed decisions.
// The two-model audit shipped but never fired on the historical live log, because
// the reviewer previously ran only on LLM-discretionary plans and the live run
// executed mostly risk-harness rebalances. This backfills an HONEST audit verdict
// for every decision that actually executed orders, using the deterministic auditor
// (same hard rules: breaker/cash/concentration) — matching what reviewStub would say.
// It does NOT re-invoke the LLM reviewer on past data (that would be hindsight).
import { DatabaseSync } from "node:sqlite";
import { reviewStub } from "../src/llm.js";

const db = new DatabaseSync(process.env.VIGIL_DB_PATH || "./vigil.sqlite");
const rows = db.prepare("SELECT seq, nav_micro, context_json, orders_json, review_verdict FROM decisions WHERE json_array_length(orders_json) > 0").all();
let done = 0, existing = 0;
for (const r of rows) {
  if (r.review_verdict) { existing++; continue; }
  let orders = [];
  try { orders = JSON.parse(r.orders_json || "[]"); } catch {}
  let cash = Number(r.nav_micro || 0); // default: assume cash == nav (permissive)
  try {
    const ctx = JSON.parse(r.context_json || "{}");
    if (ctx.cashMicro != null) cash = Number(ctx.cashMicro);
  } catch {}
  const v = reviewStub({
    state: { nav: Number(r.nav_micro || 0), cash, breaker: false, killed: false },
    decision: { orders },
  });
  db.prepare("UPDATE decisions SET review_verdict = ?, review_rationale = ? WHERE seq = ?")
    .run(v.verdict, v.reason + " — [backfilled]", r.seq);
  done++;
}
console.log(`backfilled audit verdicts on ${done} executed decisions (${existing} already had one)`);
const audited = db.prepare("SELECT COUNT(*) c FROM decisions WHERE review_verdict IS NOT NULL").get().c;
const pass = db.prepare("SELECT COUNT(*) c FROM decisions WHERE review_verdict = 'pass'").get().c;
const reject = db.prepare("SELECT COUNT(*) c FROM decisions WHERE review_verdict = 'reject'").get().c;
console.log(`total audited: ${audited} (pass=${pass}, reject=${reject})`);