---
name: pharos-pay-check
description: Decide whether a payment on Pharos Pacific Mainnet is safe to send — GO, REVIEW or STOP — from live chain data supplied by the Pharos Chain MCP (mcp.pharos.xyz), and prepare the unsigned transaction. Checks the payee (wallet, contract, a token contract, the token itself, the zero address), a look-alike of a payee the wallet already pays (address poisoning), whether this wallet has paid this payee before and how much it usually sends, the balance, the USDC blacklist, gas, and whether the payment itself would revert. Every reason cites the Chain MCP call it rests on. Use for "send / pay / transfer X USDC (or PROS, WPROS) from 0x… to 0x…", "is it safe to pay this address", "enviar/pagar … para 0x…" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
  needs: "Pharos Chain MCP — https://mcp.pharos.xyz/mcp (get_block_number, get_code, get_balance, get_transaction_count, get_gas_price, eth_call, get_logs, estimate_gas)"
---

# Pharos Pay Check — a Skill composed with the Chain MCP

This skill makes a decision; the Pharos Chain MCP supplies every chain fact it decides on. The skill never reads the
chain itself: it declares the calls it needs, in rounds, and decides from the answers. Round 3 is chosen from what
round 2 returned — the two tools are composed, not used side by side.

```
request ─▶ intent ─▶ round1() ──▶ MCP get_block_number
                   ─▶ needs()  ──▶ MCP get_code ×2 · get_balance · get_transaction_count ×2 · get_gas_price
                                       eth_call (balanceOf, isBlacklisted ×2) · get_logs ×2 per 1,000 blocks
                   ─▶ digest()     known payees · look-alikes (pure, no call)
                   ─▶ followUp() ─▶ MCP eth_call name/symbol/decimals (payee with code) · get_balance (look-alike) · estimate_gas
                   ─▶ decide()     GO / REVIEW / STOP + reasons citing call ids + unsigned tx (unless STOP)
```

The full order with every call: [references/flow.md](references/flow.md).

## When to use

- Before any transfer the user asks for on Pharos: "send 250 USDC from 0x… to 0x…".
- When the user asks whether an address is safe to pay, or why a payment was stopped.

## How to run it

The executable lives in the repository root (`tasks/flow/flow.js`). From there:

```bash
npm install
npm run flow -- "send 25 USDC from 0xPayer… to 0xPayee…"          # verdict + reasons + unsigned tx
npm run flow -- "enviar 1 PROS de 0x… para 0x…" --calls           # also every Chain MCP call, in order
npm run flow -- "…" --json                                        # the whole run for another agent
```

Exit codes: `0` GO or REVIEW · `3` STOP · `2` a request it cannot understand (no MCP call made) · `1` the Chain MCP failed.

## What it decides

| verdict | when |
|---|---|
| STOP | the payee is the zero address, the payer, the token contract itself, or another token contract; it looks like a known payee but is not (address poisoning); not enough balance or PROS for gas; blacklisted by USDC; the payment's own estimate reverts |
| REVIEW | a first payment to this address; an unknown contract; more than 10× what this wallet usually sends this payee |
| GO | none of the above: e.g. a payee this wallet already pays, with money and gas to spare |

## Rules for the agent

1. Use only what the Chain MCP returned in this run; never fill a gap from memory. If a call fails, say which.
2. Show the verdict, then every reason with its call ids. Never soften a STOP into a REVIEW.
3. For a look-alike, name both addresses in full and tell the user to copy the payee from a trusted source, never
   from the transaction history.
4. The unsigned transaction is for the user's wallet to sign; never ask for a key.
