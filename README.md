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
  service cannot influence the market. Each period's returns are committed
  to a block hash that did not exist when the period was chosen, and stored
  on first use, so the market is unpredictable in advance and permanently
  verifiable afterwards.
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

Clone with submodules. Foundry dependencies are git submodules, so without
the flag `contracts/lib/` arrives empty and nothing compiles:

```bash
git clone --recurse-submodules https://github.com/ratmol/Monad_Blitz.git
cd Monad_Blitz
```

Already cloned without it? `git submodule update --init --recursive`.

### Contracts

Install Foundry, then build and test:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup

cd contracts
forge build
forge test
```

On Windows in Git Bash, `foundryup` cannot detect the shell and will not
edit your PATH. Add it yourself before `foundryup` will resolve:

```bash
export PATH="$HOME/.foundry/bin:$PATH"   # add to ~/.bashrc to persist
```

### Deploying to Monad testnet

`monad_testnet` is defined under `rpc_endpoints` in `foundry.toml`, so the
URL does not need repeating on the command line.

```bash
cp .env.example .env     # fill in PRIVATE_KEY and AGENT_ADDRESS
set -a && source .env && set +a

cd contracts
forge script script/Deploy.s.sol --rpc-url monad_testnet          # simulate, free
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast   # spends MON
```

Run the simulation first. It costs nothing, confirms the chain id, and
prints the gas estimate. Only the second command spends MON, roughly 0.3 at
current testnet gas prices.

The deploy script asserts `block.chainid == 10143` and reverts before
spending anything if the RPC points at the wrong network.

### App

```bash
cd app
npm install
npm run dev
```

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `PRIVATE_KEY` | deploy script | deployer key, becomes the vault owner |
| `AGENT_ADDRESS` | deploy script | address permitted to call `rebalance()` |
| `MONAD_RPC_URL` | agent service | testnet RPC endpoint |
| `AGENT_PRIVATE_KEY` | agent service | key matching `AGENT_ADDRESS` |
| `VAULT_ADDRESS` | agent service, dashboard | deployed vault, set after deploy |

`PRIVATE_KEY` must be 0x-prefixed. Use a throwaway wallet funded from the
Monad testnet faucet, never a wallet that holds real funds. `.env` is
gitignored; so are `contracts/cache/` and `contracts/broadcast/`, which is
where Foundry writes deploy artifacts containing the signing key.

## License

MIT
