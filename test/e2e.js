// End-to-end, live: the real Pharos Chain MCP (mcp.pharos.xyz) on Pacific mainnet. Read-only; nothing is signed or sent.
//   node test/e2e.js   (~1 min; the Chain MCP limits requests per minute, so the runs are spaced out)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openChainMcp } from "../lib/mcp.js";
import { runFlow } from "../lib/flow.js";
import handler from "../api/flow.js";

const root = new URL("..", import.meta.url);
const PAYER = "0x08cd62babd8Dac7404504792Df30C12fC5384Df5";
const PAYEE = "0x884B9Cee8b6c3Ba3A2aAF9842BEbCd8aB4c25515";
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const cli = (...args) => spawnSync(process.execPath, ["tasks/flow/flow.js", ...args], { encoding: "utf8", cwd: root });
const pause = () => new Promise((r) => setTimeout(r, 5000));
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

await check("one request → three rounds of Chain MCP calls → a verdict whose every reason cites a successful MCP call", async () => {
  const mcp = await openChainMcp();
  try {
    const r = await runFlow(`send 1 USDC from ${PAYER} to ${PAYEE}`, { mcp, lookbackBlocks: 5000 });
    assert.deepEqual(r.rounds.map((x) => x.round), [1, 2, 3]);
    assert.equal(r.calls[0].tool, "get_block_number");
    assert.ok(r.calls.every((c) => c.digest || c.error), "every call is recorded with its answer's digest or its error");
    assert.ok(r.calls.filter((c) => c.round === 2).some((c) => c.tool === "get_logs"));
    assert.ok(r.calls.filter((c) => c.round === 3).some((c) => c.tool === "estimate_gas"));
    const ids = new Map(r.calls.map((c) => [c.id, c]));
    for (const x of r.decision.reasons) for (const id of x.evidence) assert.ok(ids.has(id), `${x.code} cites ${id}`);
    assert.ok(["GO", "REVIEW", "STOP"].includes(r.decision.verdict));
    assert.ok(r.decision.reasons.some((x) => x.code === "balance"));
    assert.ok(r.chain.head > 22_000_000);
  } finally {
    await mcp.close();
  }
});
await pause();

await check("live STOP: USDC sent to the USDC contract — and the Chain MCP's estimate_gas carries the revert reason", async () => {
  const mcp = await openChainMcp();
  try {
    const r = await runFlow(`send 1 USDC from ${PAYER} to ${USDC}`, { mcp, lookbackBlocks: 1000 });
    assert.equal(r.decision.verdict, "STOP");
    assert.ok(r.decision.reasons.some((x) => x.code === "token-itself"));
    const est = r.calls.find((c) => c.tool === "estimate_gas");
    assert.equal(est.ok, false);
    assert.match(est.error, /blacklisted/i);
    assert.equal(r.decision.tx, null);
  } finally {
    await mcp.close();
  }
});
await pause();

await check("CLI: a request runs end to end (exit 0, or 3 for STOP); a request it cannot understand exits 2 before any MCP call", async () => {
  const ok = cli(`send 1 USDC from ${PAYER} to ${PAYEE}`, "--lookback", "2000", "--calls");
  assert.ok([0, 3].includes(ok.status), ok.stderr);
  assert.match(ok.stdout, /round 1 {2}skill asks → Chain MCP answers/);
  assert.match(ok.stdout, /Chain MCP calls/);
  assert.match(ok.stdout, /c1 +r1 get_block_number/);
  for (const [args, re] of [[["hello"]], [["send 5 USDC to", PAYEE], /which wallet pays/], [[`send 1,250 USDC from ${PAYER} to ${PAYEE}`], /ambiguous/], [[`send 1 USDC from ${PAYER} to ${PAYEE}`, "--lookback", "5"], /--lookback/], [[`send 1 USDC from ${PAYER} to ${PAYEE}`, "--bogus"], /unknown flag/]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(" ")} → ${r.status}`);
    if (re) assert.match(r.stderr, re);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  }
});
await pause();

await check("API: a live run, and bad input rejected before any MCP call", async () => {
  const call = (body, method = "POST") => new Promise((resolve) => handler(Object.assign(async function* () {}(), { method, url: "/api/flow", body }), { writeHead: (status) => ({ end: (s) => resolve({ status, json: JSON.parse(s) }) }) }));
  const a = await call({ request: `pay ${PAYEE} 2 USDC from ${PAYER}` });
  assert.equal(a.status, 200, JSON.stringify(a.json).slice(0, 300));
  assert.equal(a.json.via, "Pharos Chain MCP");
  assert.ok(a.json.calls.length > 10);
  for (const [b, m] of [[{ request: "" }], [{ request: "send money" }], [[1]], [{ request: "x" }, "GET"]]) {
    const r = await call(b, m);
    assert.ok([400, 405].includes(r.status), `${JSON.stringify(b)} → ${r.status}`);
    assert.equal(r.json.ok, false);
  }
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
