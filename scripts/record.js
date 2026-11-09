// Records the demo runs — real requests through the real flow against Pacific mainnet via the Chain MCP — and writes
// public/runs/<key>.json. The payer is a real Pacific wallet that pays one contract routinely; nothing is signed.
//   go         a payment to the payee it pays routinely
//   new        a first payment to an address it has never paid
//   token      USDC sent to the USDC contract itself
//   balance    more USDC than it holds
//   lookalike  an address made for this demo to look like its real payee (same first 4 and last 4 characters)
import { writeFile } from "node:fs/promises";
import { getAddress, keccak256, toHex } from "viem";
import { openChainMcp } from "../lib/mcp.js";
import { runFlow } from "../lib/flow.js";

const PAYER = "0x08cd62babd8Dac7404504792Df30C12fC5384Df5";
const PAYEE = "0x884B9Cee8b6c3Ba3A2aAF9842BEbCd8aB4c25515";
// a look-alike: keep "884b" … "5515", fill the middle from a hash (an address nobody controls)
const mid = keccak256(toHex("pharos-mcp-flow demo look-alike")).slice(2, 34);
export const LOOKALIKE = getAddress(`0x${PAYEE.slice(2, 6).toLowerCase()}${mid}${PAYEE.slice(-4).toLowerCase()}`);

export const RUNS = {
  go: `send 25 USDC from ${PAYER} to ${PAYEE}`,
  new: `pay 0x3333333333333333333333333333333333333333 40 USDC from ${PAYER}`,
  token: `send 25 USDC from ${PAYER} to 0xC879C018dB60520F4355C26eD1a6D572cdAC1815`,
  balance: `enviar 50000 USDC de ${PAYER} para ${PAYEE}`,
  lookalike: `send 300 USDC from ${PAYER} to ${LOOKALIKE}`,
};
const NOTES = { lookalike: `The payee ${LOOKALIKE} was made for this demo: it copies the first and last characters of the wallet's real payee ${PAYEE}. Every other value is live chain data.` };

if (process.argv[1]?.endsWith("record.js")) {
  for (const [key, text] of Object.entries(RUNS)) {
    const mcp = await openChainMcp();
    try {
      const r = await runFlow(text, { mcp });
      await writeFile(new URL(`../public/runs/${key}.json`, import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", via: "Pharos Chain MCP", note: NOTES[key] ?? null, ...r }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      console.log(`${key.padEnd(10)} ${r.decision.verdict.padEnd(7)} ${r.calls.length} MCP calls · ${(r.ms / 1000).toFixed(1)} s · ${r.decision.reasons.filter((x) => x.severity === "stop" || x.severity === "review").map((x) => x.code).join(", ") || "—"}`);
    } finally {
      await mcp.close();
    }
    await new Promise((res) => setTimeout(res, 4000)); // stay well under the Chain MCP's per-minute limit
  }
  process.exit(0);
}
