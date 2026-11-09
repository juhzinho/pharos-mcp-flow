import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, getAddress, pad } from "viem";
import { parseRequest, TOKENS } from "../lib/request.js";
import { TRANSFER_TOPIC, decide, digest, followUp, needs } from "../lib/skill.js";
import { runFlow } from "../lib/flow.js";

const PAYER = "0x08cd62babd8Dac7404504792Df30C12fC5384Df5";
const KNOWN = "0x884B9Cee8b6c3Ba3A2aAF9842BEbCd8aB4c25515";
const LOOK = "0x884BA35cd58219eCaDf67cbA2a4CF0e04A135515";
const NEW = "0x3333333333333333333333333333333333333333";
const u256 = (n) => encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]);
const log = (from, to, units, block) => ({ topics: [TRANSFER_TOPIC, pad(from.toLowerCase()), pad(to.toLowerCase())], data: u256(units), blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${String(block).padStart(64, "0")}` });

/** A Chain MCP stand-in: answers by tool and arguments, records the order of calls like the real recorder. */
function fakeMcp({ payeeCode = "0x", usdc = 2_000_000_000n, pros = 10n ** 19n, paid = [], received = [], estimateError = null, isToken = false, payeeNonce = "4", blacklisted = [] } = {}) {
  const calls = [];
  return {
    url: "fake://chain-mcp",
    calls,
    async call(tool, args, { why, round } = {}) {
      const rec = { id: `c${calls.length + 1}`, tool, args, why, round, ok: true };
      calls.push(rec);
      const fail = (m) => { rec.ok = false; throw Object.assign(new Error(`${tool}: ${m}`), { callId: rec.id }); };
      let value;
      if (tool === "get_block_number") value = { blockNumber: "22600000" };
      else if (tool === "get_code") value = { code: getAddress(args.address) === getAddress(PAYER) ? "0x" : payeeCode };
      else if (tool === "get_balance") value = { balanceWei: String(pros) };
      else if (tool === "get_transaction_count") value = { nonce: getAddress(args.address) === getAddress(PAYER) ? "17" : payeeNonce };
      else if (tool === "get_gas_price") value = { gasPriceWei: "10000000000", gasPriceGwei: "10", maxPriorityFeePerGasWei: "0" };
      else if (tool === "eth_call") {
        const sel = args.transaction.data.slice(0, 10);
        if (sel === "0x70a08231") value = { result: u256(usdc) };
        else if (sel === "0xfe575a87") value = { result: u256(blacklisted.includes(`0x${args.transaction.data.slice(-40)}`.toLowerCase()) ? 1 : 0) };
        else if (isToken) value = { result: sel === "0x313ce567" ? u256(6) : encodeAbiParameters([{ type: "string" }], ["FAKE"]) };
        else fail("execution reverted:");
      } else if (tool === "get_logs") value = (args.topics[1] ? paid : received).filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= Number(args.fromBlock) && b <= Number(args.toBlock); });
      else if (tool === "estimate_gas") { if (estimateError) fail(estimateError); value = { gas: "79801" }; }
      return { id: rec.id, value };
    },
  };
}

// ───────── the request ─────────
test("requests in English and Portuguese, amounts exact, nothing guessed", () => {
  const a = parseRequest(`send 25 USDC from ${PAYER} to ${KNOWN}`);
  assert.deepEqual([a.token, a.amount, a.units, a.from, a.to], ["USDC", "25", 25_000_000n, PAYER, KNOWN]);
  const b = parseRequest(`enviar 1,5 PROS de ${PAYER} para ${NEW}`);
  assert.deepEqual([b.token, b.units], ["PROS", 1_500_000_000_000_000_000n]);
  const c = parseRequest(`pay ${NEW} 12.5 WPROS from ${PAYER}`);
  assert.equal(c.to, NEW);
  for (const [s, re] of [["", /say what to do/], [`check ${PAYER}`, /send \/ pay/], [`send USDC to ${NEW} from ${PAYER}`, /no amount/], [`send 5 USDC to ${NEW}`, /which wallet pays/], [`send 5 USDC from ${PAYER}`, /who is paid/], [`send 1,250 USDC from ${PAYER} to ${NEW}`, /ambiguous/], [`send 0.0000001 USDC from ${PAYER} to ${NEW}`, /6 decimals/], [`send 0 USDC from ${PAYER} to ${NEW}`, /zero/]]) {
    assert.throws(() => parseRequest(s), re, s);
  }
});

// ───────── the skill's plan ─────────
test("round 2 asks for exactly what the decision needs, history in 1,000-block windows", () => {
  const { reqs, windows } = needs(parseRequest(`send 25 USDC from ${PAYER} to ${KNOWN}`), { head: 22_600_000, lookbackBlocks: 3000 });
  assert.deepEqual(windows, [[22_599_001, 22_600_000], [22_598_001, 22_599_000], [22_597_001, 22_598_000]]);
  const tools = reqs.map((q) => q.tool);
  assert.equal(tools.filter((t) => t === "get_logs").length, 6);
  assert.ok(["get_code", "get_balance", "get_transaction_count", "get_gas_price", "eth_call"].every((t) => tools.includes(t)));
  assert.ok(reqs.every((q) => q.why), "every call says why");
  const pros = needs(parseRequest(`send 1 PROS from ${PAYER} to ${KNOWN}`), { head: 22_600_000, lookbackBlocks: 1000 });
  assert.ok(!pros.reqs.some((q) => q.key === "payerToken" || q.key.endsWith("Blacklisted")), "no token calls for a PROS payment");
});

// ───────── decisions, end to end through the flow with a stand-in MCP ─────────
const run = (text, opts) => runFlow(text, { mcp: fakeMcp(opts), lookbackBlocks: 2000 });
const history = Array.from({ length: 12 }, (_, i) => log(PAYER, KNOWN, 300_000_000n, 22_599_100 - i * 80)); // all inside the last 2,000 blocks

test("GO: a known payee, enough money, the estimate passes — the unsigned transaction is ready", async () => {
  const r = await run(`send 25 USDC from ${PAYER} to ${KNOWN}`, { paid: history });
  assert.equal(r.decision.verdict, "GO");
  assert.deepEqual(r.rounds.map((x) => x.round), [1, 2, 3]);
  const known = r.decision.reasons.find((x) => x.code === "known-payee");
  assert.match(known.text, /paid it 12× .*typical 300 USDC/);
  assert.ok(known.evidence.every((id) => r.calls.find((c) => c.id === id)?.tool === "get_logs"), "the evidence is the get_logs calls");
  assert.equal(r.decision.tx.nonce, 17);
  assert.equal(r.decision.tx.to, TOKENS.USDC.address);
});

test("the order of calls: head first, then everything about the payment, then what round 2 raised", async () => {
  const r = await run(`send 25 USDC from ${PAYER} to ${KNOWN}`, { paid: history, payeeCode: "0x6080" });
  assert.equal(r.calls[0].tool, "get_block_number");
  const r3 = r.calls.filter((c) => c.round === 3).map((c) => c.tool);
  assert.deepEqual(r3, ["eth_call", "eth_call", "eth_call", "estimate_gas"], "a payee with code → name/symbol/decimals, then the estimate");
  assert.ok(r.calls.filter((c) => c.round === 2).every((c) => c.round === 2) && Math.max(...r.calls.filter((c) => c.round === 2).map((c) => Number(c.id.slice(1)))) < Math.min(...r.calls.filter((c) => c.round === 3).map((c) => Number(c.id.slice(1)))));
});

test("STOP: a look-alike of the known payee — and its own transfers to the payer are named", async () => {
  const planted = [log(LOOK, PAYER, 0n, 22_599_500)];
  const r = await run(`send 300 USDC from ${PAYER} to ${LOOK}`, { paid: history, received: planted, payeeNonce: "0", pros: 0n });
  assert.equal(r.decision.verdict, "STOP");
  const l = r.decision.reasons.find((x) => x.code === "lookalike");
  assert.match(l.text, new RegExp(`is NOT ${KNOWN}`));
  assert.match(l.text, /sent this wallet 1 transfer/);
  assert.equal(r.decision.tx, null);
  assert.ok(r.calls.some((c) => c.round === 3 && c.tool === "get_balance" && c.args.address === LOOK));
});

test("STOP: a token contract as the payee; the token itself; not enough balance; the estimate reverting", async () => {
  const tok = await run(`send 5 USDC from ${PAYER} to ${NEW}`, { payeeCode: "0x6080", isToken: true });
  assert.ok(tok.decision.reasons.some((x) => x.code === "payee-is-token" && /token contract \(FAKE\)/.test(x.text)));
  const self = await run(`send 5 USDC from ${PAYER} to ${TOKENS.USDC.address}`, { payeeCode: "0x6080", estimateError: "execution reverted: Blacklistable: account is blacklisted" });
  assert.deepEqual(self.decision.reasons.filter((x) => x.severity === "stop").map((x) => x.code).sort(), ["token-itself", "would-revert"]);
  assert.ok(!self.decision.reasons.some((x) => x.code === "new-payee"), "no noise once the payee is known to be wrong");
  const poor = await run(`send 5000 USDC from ${PAYER} to ${KNOWN}`, { paid: history, usdc: 1_000_000n });
  assert.match(poor.decision.reasons.find((x) => x.code === "balance").text, /holds 1 USDC; the payment is 5000 USDC/);
  assert.ok(poor.decision.reasons.some((x) => x.code === "unusual-amount"));
});

test("REVIEW: a new payee that has never transacted; a contract nobody here has paid", async () => {
  const n = await run(`send 5 USDC from ${PAYER} to ${NEW}`, { payeeNonce: "0" });
  assert.equal(n.decision.verdict, "REVIEW");
  assert.match(n.decision.reasons.find((x) => x.code === "new-payee").text, /never sent a transaction itself/);
  assert.ok(n.decision.tx, "REVIEW still prepares the transaction");
  const c = await run(`send 5 USDC from ${PAYER} to ${NEW}`, { payeeCode: "0x6080" });
  assert.equal(c.decision.reasons.find((x) => x.code === "payee-contract").severity, "review");
  const routine = await run(`send 5 USDC from ${PAYER} to ${KNOWN}`, { payeeCode: "0x6080", paid: history });
  assert.equal(routine.decision.reasons.find((x) => x.code === "payee-contract").severity, "info");
});

test("a revert with no reason is explained (a contract payee that cannot take native PROS)", async () => {
  const r = await run(`send 1 PROS from ${PAYER} to ${KNOWN}`, { paid: history, payeeCode: "0x6080", estimateError: "execution reverted:" });
  assert.equal(r.decision.reasons.find((x) => x.code === "would-revert").text, "The payment would revert without a reason — the payee is a contract that does not accept this PROS payment (no way to receive native PROS).");
});

test("PROS payments: the amount and the gas both come out of the PROS balance", async () => {
  // 10 PROS held: 9.99 + gas (79,801 × 10 gwei ≈ 0.0008) fits; 9.9999 + gas does not
  assert.equal((await run(`send 9.99 PROS from ${PAYER} to ${KNOWN}`, { paid: history, pros: 10n ** 19n })).decision.verdict, "GO");
  const r = await run(`send 9.9999 PROS from ${PAYER} to ${KNOWN}`, { paid: history, pros: 10n ** 19n });
  assert.equal(r.decision.verdict, "STOP");
  assert.match(r.decision.reasons.find((x) => x.code === "no-gas").text, /needs 10\.000698 \(gas \+ the amount\)/);
  assert.equal(r.decision.tx, null);
});

test("every reason cites calls that exist in the record", async () => {
  for (const opts of [{ paid: history }, { payeeCode: "0x6080", isToken: true }, { payeeNonce: "0" }]) {
    const r = await run(`send 5 USDC from ${PAYER} to ${opts.paid ? KNOWN : NEW}`, opts);
    const ids = new Set(r.calls.map((c) => c.id));
    for (const x of r.decision.reasons) assert.ok(x.evidence.length && x.evidence.every((id) => ids.has(id)), `${x.code}: ${x.evidence}`);
  }
});

test("digest: known payees and look-alikes from the payer's history", () => {
  const intent = parseRequest(`send 1 USDC from ${PAYER} to ${LOOK}`);
  const d = digest(intent, { "paid:0": { id: "c2", value: history }, "received:0": { id: "c3", value: [] } });
  assert.equal(d.known[0].address, KNOWN);
  assert.deepEqual(d.lookalikes.map((k) => k.address), [KNOWN]);
  assert.equal(followUp(intent, { payeeCode: { value: { code: "0x" } } }, d).at(-1).tool, "estimate_gas");
});
