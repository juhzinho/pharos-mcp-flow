import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { keccak256, stringToHex } from "viem";

// The Pharos Chain MCP (https://mcp.pharos.xyz/mcp) as this flow's ONLY source of chain data. Every call goes
// through a recorder: tool, arguments, when, how long, and a digest of the answer — so each fact the skill uses can
// be traced back to the exact call that produced it.

export const CHAIN_MCP_URL = process.env.PHAROS_CHAIN_MCP_URL ?? "https://mcp.pharos.xyz/mcp";
const TIMEOUT = 45_000;
const TRANSIENT = /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|timed? ?out|aborted|\b(429|500|502|503|504)\b|rate limit|too many requests/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = `${e?.message} ${e?.cause?.message ?? ""}`;
      if (attempt >= 4 || !TRANSIENT.test(msg)) throw attempt ? new Error(`${label}: ${e.message}`) : e;
      // the hosted server limits requests per minute per IP: back off long when told so
      await sleep(/429|rate limit|too many/i.test(msg) ? 8000 * (attempt + 1) : 500 * 2 ** attempt);
    }
  }
}

/** Connects and returns { call(tool, args, opts), calls, close } — `calls` is the ordered record of every call. */
export async function openChainMcp({ url = CHAIN_MCP_URL, concurrency = 4 } = {}) {
  const client = await retry(async () => {
    const c = new Client({ name: "pharos-pay-check", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: TIMEOUT });
    return c;
  }, `connect to ${url}`);
  const calls = [];
  let active = 0;
  const queue = [];
  const gate = async (fn) => {
    if (active >= concurrency) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
  async function call(tool, args = {}, { why = "", round = null } = {}) {
    const rec = { id: `c${calls.length + 1}`, round, tool, args, why, at: new Date().toISOString() };
    calls.push(rec);
    const t = Date.now();
    try {
      const r = await gate(() => retry(() => client.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT }), tool));
      const text = (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      if (r.isError) {
        // the server answers errors as JSON: { error: { message, code, data } }
        let message = text;
        try {
          message = JSON.parse(text).error?.message ?? text;
        } catch {}
        throw new Error(`${tool}: ${String(message).replace(/\s+/g, " ").trim()}`);
      }
      const value = JSON.parse(text);
      Object.assign(rec, { ms: Date.now() - t, ok: true, digest: keccak256(stringToHex(text)).slice(0, 18), bytes: text.length });
      return { id: rec.id, value };
    } catch (e) {
      Object.assign(rec, { ms: Date.now() - t, ok: false, error: String(e.message).split("\n")[0].slice(0, 200) });
      e.callId = rec.id; // a failing call is still evidence (e.g. a payment whose estimate reverts)
      throw e;
    }
  }
  return { call, calls, url, close: () => client.close().catch(() => {}) };
}
