const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33), blue = c(34);
const SEV = { stop: red("STOP  "), review: yellow("REVIEW"), info: dim("info  "), ok: green("ok    ") };

export function renderRun(r, { calls = false } = {}) {
  const v = r.decision.verdict;
  const out = ["", bold(`“${r.request}”`), dim(`  → ${r.intent.amount} ${r.intent.token} from ${r.intent.from} to ${r.intent.to}`), ""];
  out.push(bold("  Flow") + dim(`  (Chain MCP ${r.chain.mcp} · head block ${r.chain.head} · ${r.calls.length} calls · ${(r.ms / 1000).toFixed(1)} s)`));
  for (const x of r.rounds) out.push(`    ${blue(`round ${x.round}`)}  skill asks → Chain MCP answers  ${dim(`${x.calls.length} call${x.calls.length > 1 ? "s" : ""}: ${x.purpose}`)}`);
  out.push(`    ${blue("decide")}   skill reads the answers → ${v === "GO" ? green(bold(v)) : v === "REVIEW" ? yellow(bold(v)) : red(bold(v))}`, "");
  out.push(bold("  Why") + dim("  (each reason → the Chain MCP calls it rests on)"));
  for (const x of r.decision.reasons) out.push(`    ${SEV[x.severity]} ${x.text} ${dim(`[${x.evidence.join(", ")}]`)}`);
  out.push("", `  ${v === "GO" ? green(bold("GO")) : v === "REVIEW" ? yellow(bold("REVIEW")) : red(bold("STOP"))}  ${r.decision.summary.replace(/^(GO|REVIEW|STOP) — /, "")}`);
  if (calls) {
    out.push("", bold("  Chain MCP calls"));
    for (const k of r.calls) out.push(dim(`    ${k.id.padEnd(4)} r${k.round} ${k.tool.padEnd(22)} ${JSON.stringify(k.args).slice(0, 70).padEnd(70)} ${String(k.ms).padStart(5)} ms ${k.ok ? k.digest : `ERROR ${k.error}`}`));
  }
  return out.join("\n");
}
