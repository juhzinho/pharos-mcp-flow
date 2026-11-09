import { parseRequest, TOKENS } from "./request.js";
import { decide, digest, followUp, needs, round1 } from "./skill.js";

// One request → one decision. The order is fixed, and every arrow is a Chain MCP call made for the skill:
//
//   user request ─▶ parseRequest ─▶ intent
//   skill.round1 ──▶ Chain MCP: get_block_number                                    (where the chain is)
//   skill.needs  ──▶ Chain MCP: get_code ×2, get_balance, get_transaction_count ×2,  (who, how much, history)
//                               get_gas_price, eth_call (balance, blacklist), get_logs × 2 per 1,000 blocks
//   skill.digest     known payees, look-alikes                                      (no calls: pure)
//   skill.followUp ▶ Chain MCP: eth_call name/symbol/decimals (payee with code),    (what round 2 raised)
//                               get_transaction_count (look-alike), estimate_gas
//   skill.decide     GO / REVIEW / STOP, each reason citing call ids, and the unsigned transaction if not STOP

export async function runFlow(text, { mcp, lookbackBlocks = 10_000, onRound = () => {} } = {}) {
  const started = Date.now();
  const intent = parseRequest(text);
  const R = {};
  const rounds = [];
  async function exec(round, purpose, reqs) {
    const before = mcp.calls.length;
    onRound({ round, purpose, calls: reqs.length });
    await Promise.all(reqs.map(async (q) => {
      try {
        const { id, value } = await mcp.call(q.tool, q.args, { why: q.why, round });
        R[q.key] = { id, value };
      } catch (e) {
        if (!q.optional || !e.callId) throw e;
        R[q.key] = { id: e.callId, error: String(e.message).split("\n")[0] };
      }
    }));
    rounds.push({ round, purpose, calls: mcp.calls.slice(before).map((c) => c.id) });
  }

  await exec(1, "where the chain is", round1());
  const head = Number(R.head.value.blockNumber);
  const plan = needs(intent, { head, lookbackBlocks });
  await exec(2, "the two addresses, the money, the history", plan.reqs);
  const d = { ...digest(intent, R), windows: lookbackBlocks.toLocaleString("en-US"), histSymbol: TOKENS[intent.token].address ? intent.token : "USDC" };
  await exec(3, "what round 2 raised, and the payment itself", followUp(intent, R, d));
  const decision = decide(intent, R, d);
  return {
    request: text,
    intent: { ...intent, units: intent.units.toString() },
    chain: { head, mcp: mcp.url },
    rounds,
    calls: mcp.calls,
    history: { lookbackBlocks, token: d.histSymbol, payments: d.paid.length, received: d.received.length, knownPayees: d.known.map((k) => ({ address: k.address, count: k.count })), lookalikes: d.lookalikes.map((k) => k.address) },
    decision,
    ms: Date.now() - started,
  };
}
