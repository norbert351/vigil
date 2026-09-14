// VIGIL — manual smoke run: wipe positions, run one sweep, print the resulting state.
import { openDB, flatPositions, listDecisions, getAgentState, getCash } from "../src/db.js";
import { runSweep } from "../src/agent.js";

const db = openDB();
db.prepare("DELETE FROM positions").run();
db.prepare("DELETE FROM decisions").run();
db.prepare("DELETE FROM equity_curve").run();
db.prepare("UPDATE agent_state SET cash_micro=0, realized_pnl_micro=0, kill_switched=0, nonce=0").run();

try {
  const r = await runSweep(db);
  console.log("SWEEP:", JSON.stringify(r).slice(0, 400));
  console.log("POSITIONS(micro-units):", JSON.stringify(Object.fromEntries(Object.entries(flatPositions(db)).map(([k, v]) => [k, v.toString()]))));
  console.log("CASH(micro):", getCash(db).toString());
  console.log("AGENT:", JSON.stringify(getAgentState(db)));
  const decs = listDecisions(db, 5);
  console.log("DECISIONS:", decs.length);
  if (decs[0]) console.log("LATEST:", JSON.stringify({ trigger: decs[0].trigger, window: decs[0].window, llm: decs[0].llm, rationale: decs[0].rationale }).slice(0, 300));
} catch (e) {
  console.error("SMOKE FAIL:", e.stack || e);
  process.exit(1);
}