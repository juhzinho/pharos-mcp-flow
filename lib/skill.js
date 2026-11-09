import { decodeFunctionResult, encodeFunctionData, getAddress, hexToString, isAddressEqual, pad, parseAbi, zeroAddress } from "viem";
import { TOKENS } from "./request.js";

// The pharos-pay-check skill: the decision, and only the decision. It never talks to the chain — it says which
// Chain MCP calls it needs (needs → followUp), the flow runs them, and decide() turns their answers into
// GO / REVIEW / STOP with every reason pointing at the call ids it rests on.
//   round 1  the head block (to know which blocks to read)
//   round 2  both addresses' code, the payer's balances and nonce, gas price, USDC blacklist, the payer's history of
//            payments in this token and the payee's history of receipts
//   round 3  depends on round 2: a payee with code → what is it (name/symbol/decimals: a token?); a payee that
//            looks like one of the payer's known payees but is not → the look-alike's history with the payer;
//            and the payment itself, estimated (a revert here is a reason)

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function isBlacklisted(address) view returns (bool)"]);
const call = (to, fn, args = []) => ({ to, data: encodeFunctionData({ abi: ERC20, functionName: fn, args }) });
const topicOf = (a) => pad(a.toLowerCase());

export const round1 = () => [{ key: "head", tool: "get_block_number", args: {}, why: "the head block: which blocks the history reads cover" }];

/** Round 2: everything the decision needs about the two addresses, the money and the history. */
export function needs(intent, { head, lookbackBlocks = 10_000 }) {
  const t = TOKENS[intent.token];
  const histToken = t.address ?? TOKENS.USDC.address; // a PROS payment: the payer's USDC history tells who it pays
  const reqs = [
    { key: "payerCode", tool: "get_code", args: { address: intent.from }, why: "is the payer a plain wallet?" },
    { key: "payeeCode", tool: "get_code", args: { address: intent.to }, why: "is the payee a wallet or a contract?" },
    { key: "payerPros", tool: "get_balance", args: { address: intent.from }, why: "PROS to pay gas (and the amount, for a PROS payment)" },
    { key: "payerNonce", tool: "get_transaction_count", args: { address: intent.from }, why: "the payer's next nonce, for the unsigned transaction" },
    { key: "payeeNonce", tool: "get_transaction_count", args: { address: intent.to }, why: "has the payee ever sent a transaction?" },
    { key: "gas", tool: "get_gas_price", args: {}, why: "the fee for the unsigned transaction" },
  ];
  if (t.address) reqs.push({ key: "payerToken", tool: "eth_call", args: { transaction: call(t.address, "balanceOf", [intent.from]) }, why: `the payer's ${t.symbol} balance` });
  if (t.symbol === "USDC") {
    reqs.push({ key: "payerBlacklisted", tool: "eth_call", args: { transaction: call(t.address, "isBlacklisted", [intent.from]) }, why: "is the payer blacklisted by USDC?" });
    reqs.push({ key: "payeeBlacklisted", tool: "eth_call", args: { transaction: call(t.address, "isBlacklisted", [intent.to]) }, why: "is the payee blacklisted by USDC?" });
  }
  // history: the 1,000-block windows the Chain MCP serves, newest first
  const windows = [];
  for (let hi = head; hi > head - lookbackBlocks && hi > 0; hi -= 1000) windows.push([Math.max(1, hi - 999), hi]);
  windows.forEach(([lo, hi], i) => {
    reqs.push({ key: `paid:${i}`, tool: "get_logs", args: { address: histToken, topics: [TRANSFER_TOPIC, topicOf(intent.from)], fromBlock: String(lo), toBlock: String(hi) }, why: `who the payer paid, blocks ${lo}–${hi}` });
    reqs.push({ key: `received:${i}`, tool: "get_logs", args: { address: histToken, topics: [TRANSFER_TOPIC, null, topicOf(intent.from)], fromBlock: String(lo), toBlock: String(hi) }, why: `who sent to the payer, blocks ${lo}–${hi}` });
  });
  return { reqs, windows, histToken };
}

/** Facts derived from round 2 (pure): known payees, the payee's place in the history, look-alikes. */
export function digest(intent, r) {
  const logs = (prefix) => Object.entries(r).filter(([k]) => k.startsWith(prefix)).flatMap(([, v]) => v.value.map((l) => ({ ...l, _id: v.id })));
  const paid = logs("paid:").map((l) => ({ to: getAddress(`0x${l.topics[2].slice(26)}`), units: BigInt(l.data), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, id: l._id }));
  const received = logs("received:").map((l) => ({ from: getAddress(`0x${l.topics[1].slice(26)}`), units: BigInt(l.data), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, id: l._id }));
  const known = new Map();
  for (const p of paid) {
    const k = known.get(p.to) ?? { address: p.to, count: 0, units: [], ids: new Set() };
    k.count++;
    k.units.push(p.units);
    k.ids.add(p.id);
    known.set(p.to, k);
  }
  const to = getAddress(intent.to.toLowerCase());
  const shape = (a) => `${a.slice(2, 6)}…${a.slice(-4)}`.toLowerCase();
  const lookalikes = [...known.values()].filter((k) => k.address !== to && shape(k.address) === shape(to));
  return { paid, received, known: [...known.values()], toKnown: known.get(to) ?? null, lookalikes, to };
}

/** Round 3: what the decision needs after seeing round 2. */
export function followUp(intent, r, d) {
  const reqs = [];
  const code = r.payeeCode.value.code;
  if (code && code !== "0x" && !code.startsWith("0xef0100")) {
    for (const fn of ["name", "symbol", "decimals"]) reqs.push({ key: `payee:${fn}`, tool: "eth_call", args: { transaction: call(intent.to, fn) }, why: `the payee is a contract — is it a token? (${fn}())`, optional: true });
  }
  // a look-alike of a known payee: what footprint does the requested address itself have?
  if (d.lookalikes.length) reqs.push({ key: "lookalike:footprint", tool: "get_balance", args: { address: intent.to }, why: `the requested payee looks like ${d.lookalikes[0].address}, whom the payer has paid ${d.lookalikes[0].count}× — how much has the look-alike itself ever held?` });
  const t = TOKENS[intent.token];
  const tx = t.address ? { from: intent.from, ...call(t.address, "transfer", [intent.to, intent.units]) } : { from: intent.from, to: intent.to, value: `0x${intent.units.toString(16)}` };
  reqs.push({ key: "estimate", tool: "estimate_gas", args: { transaction: tx }, why: "would the payment itself go through? (a revert is a reason)", optional: true });
  return reqs;
}

const uint = (v) => BigInt(v?.value?.result ?? "0x0");
const fmt = (units, decimals) => {
  const b = 10n ** BigInt(decimals);
  const f = (units % b).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return (units / b).toLocaleString("en-US") + (f ? `.${f}` : "");
};
const tryString = (v) => {
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: "name", data: v.value.result });
  } catch {
    try {
      return hexToString(v.value.result, { size: 32 }).replace(/\0/g, "");
    } catch {
      return null;
    }
  }
};

/** The decision. `r` = every answer by key ({ id, value } or { id, error }). */
export function decide(intent, r, d) {
  const t = TOKENS[intent.token];
  const reasons = [];
  const add = (severity, code, text, ...ids) => reasons.push({ severity, code, text, evidence: ids.flat().filter(Boolean) });
  const to = d.to;
  const payeeCode = r.payeeCode.value.code;
  const payerCode = r.payerCode.value.code;

  // the payee itself
  if (isAddressEqual(to, zeroAddress)) add("stop", "zero-address", "The payee is the zero address: the money would be burned.", r.payeeCode.id);
  if (isAddressEqual(to, getAddress(intent.from.toLowerCase()))) add("stop", "self", "The payee is the payer itself.", r.payerCode.id);
  if (t.address && isAddressEqual(to, t.address)) add("stop", "token-itself", `The payee is the ${t.symbol} contract itself: tokens sent to their own contract are usually lost for good.`, r.payeeCode.id);
  const isToken = r["payee:symbol"]?.value && r["payee:decimals"]?.value && !r["payee:symbol"].error;
  if (payeeCode && payeeCode !== "0x" && !payeeCode.startsWith("0xef0100")) {
    if (isToken && !(t.address && isAddressEqual(to, t.address))) {
      const sym = tryString(r["payee:symbol"]);
      add("stop", "payee-is-token", `The payee is a token contract (${sym ?? "it answers symbol() and decimals()"}), not a wallet: a transfer to it is almost always a mistake and cannot be undone.`, r.payeeCode.id, r["payee:symbol"].id, r["payee:decimals"].id);
    } else if (!isToken) {
      // a contract this wallet already pays routinely is an established payee; an unknown one needs a look
      if (d.toKnown) add("info", "payee-contract", `The payee is a contract (${(payeeCode.length - 2) / 2} bytes of code) — one this wallet pays routinely.`, r.payeeCode.id);
      else add("review", "payee-contract", `The payee is a contract (${(payeeCode.length - 2) / 2} bytes of code), not a wallet — make sure it is meant to receive ${t.symbol} directly.`, r.payeeCode.id);
    }
  }
  if (payeeCode?.startsWith("0xef0100")) add("info", "payee-7702", "The payee is a wallet with an EIP-7702 delegation (a key-held account).", r.payeeCode.id);

  // look-alikes: the address-poisoning pattern
  for (const k of d.lookalikes) {
    const seen = d.received.filter((x) => x.from === to);
    const fp = r["lookalike:footprint"];
    const empty = fp?.value && BigInt(fp.value.balanceWei) === 0n && Number(r.payeeNonce.value.nonce) === 0;
    add("stop", "lookalike", `The payee ${to} is NOT ${k.address}, whom this wallet has paid ${k.count}× in the window — same first and last characters, different address. This is how address-poisoning scams work${seen.length ? `; ${to} has also sent this wallet ${seen.length} transfer(s) of its own (planting itself in the history)` : ""}${empty ? "; the look-alike holds no PROS and has never sent a transaction" : ""}.`, [...k.ids], fp?.id, r.payeeNonce.id, seen.map((x) => x.id));
  }

  // history
  const histIds = Object.entries(r).filter(([k]) => k.startsWith("paid:")).map(([, v]) => v.id);
  const windowText = `${d.windows} blocks`;
  if (d.toKnown) {
    const med = [...d.toKnown.units].sort((a, b) => (a < b ? -1 : 1))[Math.floor(d.toKnown.units.length / 2)];
    add("ok", "known-payee", `A known payee: this wallet paid it ${d.toKnown.count}× in the last ${windowText} (typical ${fmt(med, TOKENS[d.histSymbol].decimals)} ${d.histSymbol}).`, [...d.toKnown.ids]);
    if (d.histSymbol === intent.token && med > 0n && intent.units > med * 10n) add("review", "unusual-amount", `${intent.amount} ${t.symbol} is more than 10× what this wallet usually sends this payee (${fmt(med, t.decimals)}).`, [...d.toKnown.ids]);
  } else if (!d.lookalikes.length && !reasons.some((x) => ["token-itself", "payee-is-token", "zero-address", "self"].includes(x.code))) {
    // (when the payee is already known to be wrong, "new payee" would only be noise)
    const fresh = Number(r.payeeNonce.value.nonce) === 0 && (!payeeCode || payeeCode === "0x");
    add("review", "new-payee", `A first payment to this address: the wallet has not paid it in the last ${windowText}${fresh ? ", and the address has never sent a transaction itself" : ""}. Confirm it out of band.`, histIds.slice(0, 3), r.payeeNonce.id);
  }

  // money and permissions
  const pros = BigInt(r.payerPros.value.balanceWei);
  if (t.address) {
    const bal = uint(r.payerToken);
    if (bal < intent.units) add("stop", "balance", `The payer holds ${fmt(bal, t.decimals)} ${t.symbol}; the payment is ${intent.amount} ${t.symbol}.`, r.payerToken.id);
    else add("ok", "balance", `The payer holds ${fmt(bal, t.decimals)} ${t.symbol} — enough.`, r.payerToken.id);
  } else if (pros < intent.units) add("stop", "balance", `The payer holds ${fmt(pros, 18)} PROS; the payment is ${intent.amount} PROS.`, r.payerPros.id);
  if (t.symbol === "USDC") {
    if (uint(r.payerBlacklisted) === 1n) add("stop", "payer-blacklisted", "USDC has blacklisted the payer.", r.payerBlacklisted.id);
    if (uint(r.payeeBlacklisted) === 1n) add("stop", "payee-blacklisted", "USDC has blacklisted the payee: the transfer would revert.", r.payeeBlacklisted.id);
  }
  if (payerCode && payerCode !== "0x") add("info", "payer-code", payerCode.startsWith("0xef0100") ? "The payer has an EIP-7702 delegation." : "The payer is a contract (a smart wallet): it signs through its own logic.", r.payerCode.id);

  // the payment, estimated
  const gasPrice = BigInt(r.gas.value.gasPriceWei);
  if (r.estimate?.error) {
    const why = r.estimate.error.replace(/^estimate_gas:\s*/, "").replace(/^execution reverted:?\s*$/i, "").slice(0, 160);
    add("stop", "would-revert", why ? `Estimating the payment fails: ${why}.` : `The payment would revert without a reason${payeeCode && payeeCode !== "0x" ? ` — the payee is a contract that does not accept this ${t.address ? "transfer" : "PROS payment (no way to receive native PROS)"}` : ""}.`, r.estimate.id);
  }
  else if (r.estimate) {
    const gas = BigInt(r.estimate.value.gas);
    const fee = gas * gasPrice;
    const needPros = fee + (t.address ? 0n : intent.units);
    if (pros < needPros) add("stop", "no-gas", `The payer holds ${fmt(pros, 18)} PROS and needs ${fmt(needPros, 18)} (gas${t.address ? "" : " + the amount"}).`, r.payerPros.id, r.estimate.id, r.gas.id);
    else add("ok", "gas", `The payment estimates at ${gas.toLocaleString("en-US")} gas × ${r.gas.value.gasPriceGwei} gwei = ${fmt(fee, 18)} PROS.`, r.estimate.id, r.gas.id);
  }

  const verdict = reasons.some((x) => x.severity === "stop") ? "STOP" : reasons.some((x) => x.severity === "review") ? "REVIEW" : "GO";
  let tx = null;
  if (verdict !== "STOP" && r.estimate && !r.estimate.error) {
    const gas = (BigInt(r.estimate.value.gas) * 12n) / 10n;
    tx = t.address
      ? { chainId: 1672, from: getAddress(intent.from.toLowerCase()), to: t.address, value: "0x0", data: call(t.address, "transfer", [to, intent.units]).data, nonce: Number(r.payerNonce.value.nonce), gas: `0x${gas.toString(16)}`, maxFeePerGas: `0x${(gasPrice * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${BigInt(r.gas.value.maxPriorityFeePerGasWei).toString(16)}`, type: "0x2" }
      : { chainId: 1672, from: getAddress(intent.from.toLowerCase()), to, value: `0x${intent.units.toString(16)}`, data: "0x", nonce: Number(r.payerNonce.value.nonce), gas: `0x${gas.toString(16)}`, maxFeePerGas: `0x${(gasPrice * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${BigInt(r.gas.value.maxPriorityFeePerGasWei).toString(16)}`, type: "0x2" };
  }
  const order = { stop: 0, review: 1, info: 2, ok: 3 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary = verdict === "STOP" ? `STOP — ${reasons.filter((x) => x.severity === "stop").map((x) => x.code).join(", ")}: nothing prepared.` : verdict === "REVIEW" ? `REVIEW — ${reasons.filter((x) => x.severity === "review").map((x) => x.code).join(", ")}: the unsigned transaction is prepared; read the reasons before signing.` : `GO — send ${intent.amount} ${t.symbol} to ${to}: the unsigned transaction is ready to sign.`;
  return { verdict, summary, reasons, tx };
}

export { topicOf };
