#!/usr/bin/env node
// Skill + Chain MCP flow for Pharos Pacific: one request in plain words → the pharos-pay-check skill asks for the
// chain data it needs → the Pharos Chain MCP supplies it live → the skill decides GO / REVIEW / STOP, every reason
// citing the MCP calls it rests on, and prepares the unsigned transaction when it is not STOP.
//   npm run flow -- "send 25 USDC from 0x… to 0x…"
//   npm run flow -- "enviar 1 PROS de 0x… para 0x…" --calls          also list every Chain MCP call
//   npm run flow -- "…" --json                                       the whole run, machine-readable
//   npm run flow -- "…" --lookback 20000                             how many blocks of history (1,000–50,000)
import { openChainMcp } from "../../lib/mcp.js";
import { runFlow } from "../../lib/flow.js";
import { renderRun } from "../../lib/render.js";

const USAGE = `usage: npm run flow -- "<send|pay|transfer|enviar|pagar> <amount> <USDC|WPROS|PROS> from 0x… to 0x…" [--calls] [--json] [--lookback <blocks>]`;
const args = process.argv.slice(2);
const flags = { calls: false, json: false, lookback: 10_000 };
const words = [];
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--calls") flags.calls = true;
    else if (args[i] === "--json") flags.json = true;
    else if (args[i] === "--lookback") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1000 || v > 50_000) throw Object.assign(new Error("--lookback: 1,000 to 50,000 blocks"), { usage: true });
      flags.lookback = v;
    } else if (args[i].startsWith("--")) throw Object.assign(new Error(`unknown flag ${args[i]}`), { usage: true });
    else words.push(args[i]);
  }
  if (!words.length || args.includes("-h")) {
    console.log(USAGE);
    process.exit(words.length ? 0 : 2);
  }
  const text = words.join(" ");
  // the request is read before connecting: a request that cannot be understood costs no MCP call
  const { parseRequest } = await import("../../lib/request.js");
  try {
    parseRequest(text);
  } catch (e) {
    throw Object.assign(e, { usage: true });
  }
  const mcp = await openChainMcp();
  try {
    const r = await runFlow(text, { mcp, lookbackBlocks: flags.lookback, onRound: (x) => !flags.json && process.stderr.write(`  round ${x.round}: ${x.calls} Chain MCP call${x.calls > 1 ? "s" : ""} — ${x.purpose}\n`) });
    if (flags.json) console.log(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    else {
      console.log(renderRun(r, { calls: flags.calls }));
      if (r.decision.tx) console.log(`\n${JSON.stringify({ unsignedTransaction: r.decision.tx }, null, 2)}`);
    }
    process.exit(r.decision.verdict === "STOP" ? 3 : 0);
  } finally {
    await mcp.close();
  }
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  if (e.usage) console.error(`\n${USAGE}`);
  process.exit(e.usage ? 2 : 1);
}
