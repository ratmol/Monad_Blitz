# LEASH

**An AI agent that can grow your money but can never take it.**

A vault on [Monad](https://monad.xyz) where an untrusted autonomous agent
reallocates capital across strategies every few seconds and learns which
ones pay off, while the smart contract enforces limits the agent physically
cannot break.

Built at Monad Blitz Toronto.

## The idea

Most on-chain AI agents hold a private key and hope for the best. If the
agent is compromised or misbehaves, the funds are gone. LEASH inverts that:
the agent is assumed untrusted, and the vault contract is what constrains it.

- The agent can call `rebalance()`. It **cannot** call `withdraw()`. Fund
  custody and fund operation are separate roles enforced on-chain.
- The contract caps how much can sit in any one strategy, enforces a
  cooldown between reallocations, and halts the agent automatically if the
  vault draws down past a threshold.
- Strategy returns are derived from on-chain block data, so the off-chain
  service cannot influence the market and anyone can verify results
  independently.
- Every reallocation emits an event, so the agent's complete decision
  history is reconstructable from chain logs.

## Why Monad

The strategy requires a reallocation roughly every three seconds, about
1,200 transactions per hour. At typical Ethereum L1 fees that is thousands
of dollars per day in gas, which makes the strategy economically impossible.
Monad's sub-second blocks and negligible fees are what let an autonomous
agent act at this frequency at all.

The dashboard shows a live counter of transactions sent, gas spent, and what
the same run would have cost elsewhere.

## How the agent learns

A contextual multi-armed bandit with epsilon-greedy exploration. The agent
tries allocations, scores the outcome from real on-chain results, exploits
what works, and keeps exploring. This is online reinforcement learning,
chosen deliberately because it converges in minutes rather than days, which
is the only thing that works for an agent acting in real time.

A naive baseline agent runs alongside it for comparison.

## Architecture

```
Dashboard (Next.js)  <-- polls --  Agent service (Node/TS)
                                     |  read state -> bandit picks weights
                                     |  -> send rebalance() -> score reward
                                     v  ChainAdapter
                                   LeashVault.sol on Monad testnet
```

All chain access goes through a single `ChainAdapter` interface, so the
service and dashboard are testable against a mock without a chain
connection.

## Stack

| Layer | Tools |
|---|---|
| Contracts | Solidity, Foundry, OpenZeppelin |
| Chain | Monad testnet, viem |
| Agent | Node, TypeScript |
| Dashboard | Next.js, Tailwind, Recharts |

## Running locally

```bash
# contracts
cd contracts
forge build
forge test
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --broadcast

# app
cd app
npm install
cp .env.example .env   # fill in RPC url, agent key, vault address
npm run dev
```

## Environment

```
MONAD_RPC_URL=
AGENT_PRIVATE_KEY=
VAULT_ADDRESS=
```

Use a throwaway wallet funded from the Monad testnet faucet. Never a wallet
that holds real funds.

## License

MIT
