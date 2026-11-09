import { getAddress, isAddress } from "viem";

// One request in plain words → an intent. English or Portuguese:
//   "send 250 USDC from 0xA… to 0xB…"   "pay 0xB… 12.5 WPROS from 0xA…"   "enviar 1 PROS de 0xA… para 0xB…"
// Amounts are kept as written decimal strings (never floats). Anything missing or ambiguous is an error that says
// what to add — the flow does not guess a wallet or a token.

export const TOKENS = {
  USDC: { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6 },
  WPROS: { symbol: "WPROS", address: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"), decimals: 18 },
  PROS: { symbol: "PROS", address: null, decimals: 18 },
};

const VERB = /\b(send|pay|transfer|enviar|envie|pagar|pague|transferir|transfira|mandar|mande)\b/i;
const FROM = /\b(?:from|de|da|do)\s+(0x[0-9a-fA-F]{40})\b/i;
const TO = /\b(?:to|para|pra|p\/)\s+(0x[0-9a-fA-F]{40})\b/i;
const AMOUNT = /(?<![\w.])(\d{1,15}(?:[.,]\d{1,18})?)\s*(USDC|WPROS|PROS)\b/i;

export function parseRequest(text) {
  const s = String(text ?? "").trim();
  if (!s) throw new Error("say what to do, e.g. “send 250 USDC from 0x… to 0x…”");
  if (s.length > 400) throw new Error("the request is too long (400 characters at most)");
  if (!VERB.test(s)) throw new Error("this flow checks a payment: start with send / pay / transfer (or enviar / pagar)");
  const amount = AMOUNT.exec(s);
  if (!amount) throw new Error("no amount with a token (USDC, WPROS or PROS), e.g. “250 USDC”");
  const all = [...s.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0]);
  let from = FROM.exec(s)?.[1] ?? null;
  let to = TO.exec(s)?.[1] ?? null;
  // "pay 0xB… 10 USDC from 0xA…": the address right after the verb is the payee
  if (!to) to = new RegExp(`${VERB.source}\\s+(0x[0-9a-fA-F]{40})`, "i").exec(s)?.[2] ?? null;
  if (!from) throw new Error("say which wallet pays: “… from 0x…” (or “de 0x…”)");
  if (!to) throw new Error("say who is paid: “… to 0x…” (or “para 0x…”)");
  if (all.length > 2) throw new Error("more than two addresses in the request — keep only the payer and the payee");
  for (const [k, a] of [["payer", from], ["payee", to]]) if (!isAddress(a, { strict: false })) throw new Error(`the ${k} ${a} is not an address`);
  const token = TOKENS[amount[2].toUpperCase()];
  const written = amount[1];
  // a comma is a decimal separator only when it is followed by 1–2 digits ("12,5"); "1,250" is refused as ambiguous
  if (/,\d{3}$/.test(written)) throw new Error(`“${written}” is ambiguous (1,250 or 1.25?) — write it with a dot as the decimal point`);
  const value = written.replace(",", ".");
  const [i, f = ""] = value.split(".");
  if (f.length > token.decimals) throw new Error(`${token.symbol} has ${token.decimals} decimals; “${written}” has more`);
  const units = BigInt(i) * 10n ** BigInt(token.decimals) + BigInt(f.padEnd(token.decimals, "0") || "0");
  if (units === 0n) throw new Error("the amount is zero");
  // keep what the person wrote: a mistyped checksum is a finding for the skill, not something to fix silently
  return { text: s, action: "transfer", token: token.symbol, tokenAddress: token.address, decimals: token.decimals, amount: value, units, from, to };
}
