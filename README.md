# Pharos Pay Check — a SkillEngine skill composed with the Pharos Chain MCP

One request in plain words — *“send 25 USDC from 0x… to 0x…”* — goes through **one flow**: the **pharos-pay-check**
skill decides whether the payment is safe (**GO / REVIEW / STOP**), and the **Pharos Chain MCP**
(`mcp.pharos.xyz`) is its only window on the chain. The skill asks for exactly the data it needs, in rounds; what it
asks in round 3 depends on what round 2 returned; and **every reason in the verdict cites the MCP call it rests on**.

**Live demo:** https://pharos-mcp-flow.vercel.app · **Skill:** [skill/pharos-pay-check/SKILL.md](skill/pharos-pay-check/SKILL.md) · **Flow:** [references/flow.md](skill/pharos-pay-check/references/flow.md)

```
request ─▶ intent ─▶ skill.round1 ──▶ Chain MCP: get_block_number
                   ─▶ skill.needs  ──▶ Chain MCP: get_code ×2 · get_balance · get_transaction_count ×2 · get_gas_price
                                                  eth_call balanceOf / isBlacklisted · get_logs ×2 per 1,000 blocks
                   ─▶ skill.digest     known payees · look-alikes                         (pure: no call)
                   ─▶ skill.followUp ▶ Chain MCP: eth_call name/symbol/decimals · get_balance · estimate_gas
                   ─▶ skill.decide     GO / REVIEW / STOP · reasons → call ids · unsigned transaction unless STOP
```

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | The Skill's output depends on live data fetched via Chain MCP in the same flow | The skill (`lib/skill.js`) has no chain access at all — the project has no RPC client: every chain fact comes from the Chain MCP in the same run (`lib/mcp.js`). The verdict, every reason and the unsigned transaction (nonce, gas, fees) are computed from those answers, and each reason lists the ids of the calls it used (e.g. `known-payee ← c11, c13, …` = the `get_logs` calls). Round 3 is chosen from round 2's answers (a payee with code → `name/symbol/decimals`; a look-alike → its footprint). |
| 02 | The flow runs end to end from a single user request | `npm run flow -- "send 25 USDC from 0x… to 0x…"` (or `enviar … de … para …`), `POST /api/flow`, or the box on the site: request → parse → round 1 → round 2 → digest → round 3 → decision, in ~8 s with ~30 MCP calls. A request it cannot understand is refused before any call. |
| 03 | A diagram or short write-up of the flow: what calls what, and in what order | [references/flow.md](skill/pharos-pay-check/references/flow.md): a sequence diagram (User → Flow → Skill → Chain MCP) and a round-by-round table of every tool and why. The site draws the same flow, and every run shows its own calls in order (id, round, tool, arguments, reason, ms, answer digest). |
| 04 | A demo run showing real data moving through both tools | Five runs recorded on Pacific mainnet through the Chain MCP ([public/runs](public/runs)) with a real wallet that pays one contract routinely, plus live runs from the site. Every call and its answer digest is in each file. |

## The demo runs (Pacific mainnet, via the Chain MCP)

The payer `0x08cd…4Df5` is a real Pacific wallet (an EOA) that paid the contract `0x884B…5515` 49 times in the
10,000 blocks before the recording. Nothing is signed or sent.

| run | request | verdict | what the skill saw (from the MCP) |
|---|---|---|---|
| [go](public/runs/go.json) | 25 USDC to its usual payee | **GO** | known payee (49×, typically 300 USDC), enough USDC, `estimate_gas` 79,801 → unsigned tx ready |
| [new](public/runs/new.json) | 40 USDC to an address it never paid | **REVIEW** | not in its history, and the address has never sent a transaction |
| [token](public/runs/token.json) | 25 USDC to the USDC contract | **STOP** | the payee is the token itself — and USDC has its own contract blacklisted: `estimate_gas` reverts with *Blacklistable: account is blacklisted* |
| [balance](public/runs/balance.json) | 50,000 USDC to its usual payee | **STOP** | the balance is far below; `estimate_gas` reverts *transfer amount exceeds balance*; and it is >10× the usual amount |
| [lookalike](public/runs/lookalike.json) | 300 USDC to `0x884BA35c…5515` | **STOP** | same first and last characters as its real payee `0x884B9Cee…5515`, different address — the address-poisoning pattern; the look-alike holds no PROS and never transacted |

The look-alike address was made for the demo (it copies the real payee's first 4 and last 4 characters); every
other value is live chain data. Address poisoning is rare on Pacific today (one zero-value USDC transfer in the
last 60,000 blocks when this was built), which is exactly when a check like this costs nothing to have.

## Run it

```bash
npm install
npm run flow -- "send 25 USDC from 0x08cd62babd8Dac7404504792Df30C12fC5384Df5 to 0x884B9Cee8b6c3Ba3A2aAF9842BEbCd8aB4c25515"
npm run flow -- "enviar 1 PROS de 0x… para 0x…" --calls      # also list every Chain MCP call
npm run flow -- "…" --json                                   # the whole run, machine-readable
npm run web                                                  # the demo site on http://localhost:3170
```

Exit codes: `0` GO or REVIEW · `3` STOP · `2` not understood (no MCP call made) · `1` the Chain MCP failed.
The hosted Chain MCP limits requests per minute per IP: the client runs 4 calls at a time and backs off on 429.

## Tests

```bash
npm test          # 11 unit tests: requests (EN/PT), the plan per round, every verdict through the flow with a
                  # stand-in MCP that records the call order, evidence always pointing at real calls
npm run test:e2e  # 4 live checks through the real Chain MCP: a full run, the USDC-contract STOP with the revert
                  # reason from estimate_gas, the CLI, the API
```

## Files

- `lib/skill.js` — the skill: `round1`, `needs`, `digest`, `followUp`, `decide` (pure, no chain access)
- `lib/mcp.js` — the Chain MCP client and call recorder · `lib/flow.js` — the orchestration · `lib/request.js` — the words → intent
- `tasks/flow/flow.js` — the CLI · `api/flow.js` — the live endpoint · `scripts/record.js` — the five demo runs

MIT
