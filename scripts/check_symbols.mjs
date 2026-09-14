import { refreshPrices, symbolMap } from "../src/market.js";
const px = await refreshPrices(true);
console.log("symbol map:", JSON.stringify(symbolMap()));
for (const [k,v] of Object.entries(px)) {
  console.log(k.padEnd(8), (v.symbol||"").padEnd(14), v.lastMicro!=null? ("$"+(v.lastMicro/1e6)) : ("ERR: "+v.error));
}
