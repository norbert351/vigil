import { openDB, getPositions, listDecisions, getAgentState } from "../src/db.js";
import { runSweep } from "../src/agent.js";
const db = openDB();
db.prepare("DELETE FROM positions").run();
db.prepare("DELETE FROM decisions").run();
try {
  const r = await runSweep(db);
  console.log("SWEEP:", JSON.stringify(r).slice(0, 400));
  console.log("POSITIONS:", JSON.stringify(Object.fromEntries(Object.entries(getPositions(db)).map(([k,v])=>[k,v.toString()]))));
  console.log("AGENT:", JSON.stringify(getAgentState(db)));
  const decs = listDecisions(db, 5);
  console.log("DECISIONS:", decs.length);
  if (decs[0]) console.log("LATEST DECISION:", JSON.stringify({trigger:decs[0].trigger, window:decs[0].window, llm:decs[0].llm, rationale:decs[0].rationale}).slice(0,300));
} catch (e) { console.error("SMOKE FAIL:", e.stack || e); }
