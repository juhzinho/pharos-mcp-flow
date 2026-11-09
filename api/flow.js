import { openChainMcp } from "../lib/mcp.js";
import { runFlow } from "../lib/flow.js";
import { parseRequest } from "../lib/request.js";

// POST /api/flow  { "request": "send 25 USDC from 0x… to 0x…" }
// Runs the whole flow live: the skill decides, the Pharos Chain MCP supplies every piece of chain data. Returns the
// rounds, every MCP call (tool, arguments, time, digest), the decision with its evidence, and the unsigned
// transaction when it is not STOP. Nothing is signed or sent.
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new Error("the request is too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(json(b));
  if (req.method !== "POST") return send(405, { ok: false, error: "POST { request }" });
  let text;
  try {
    let b;
    try {
      b = await body(req);
    } catch (e) {
      throw new Error(/too large/.test(e.message) ? e.message : "the body is not valid JSON");
    }
    text = String(b?.request ?? "");
    parseRequest(text); // a request that cannot be understood costs no Chain MCP call
  } catch (e) {
    return send(400, { ok: false, error: e.message });
  }
  let mcp;
  try {
    mcp = await openChainMcp();
    const r = await runFlow(text, { mcp });
    return send(200, { ok: true, network: "Pharos Pacific Mainnet", via: "Pharos Chain MCP", ranAt: new Date().toISOString(), ...r });
  } catch (e) {
    const busy = /429|rate limit|too many|timeout|ECONN|fetch failed|network/i.test(e.message);
    return send(busy ? 503 : 500, { ok: false, error: busy ? "The Pharos Chain MCP is busy right now (it limits requests per minute). Try again in a minute." : e.message.split("\n")[0], calls: mcp?.calls ?? [] });
  } finally {
    await mcp?.close();
  }
}
