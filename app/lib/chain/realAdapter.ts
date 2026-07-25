import {
  Account,
  Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  PublicClient,
  WalletClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {
  ChainStats,
  FullAdapter,
  RebalanceReceipt,
  RebalanceRejected,
  VaultState,
} from "./adapter";
import {leashVaultAbi} from "./abi";
import {BPS_DENOMINATOR, MAX_WEIGHT_BPS, MONAD_RPC_URL, STRATEGY_COUNT} from "./constants";
import {monadTestnet} from "./monad";

/**
 * The real seam implementation: viem against LeashVault on Monad testnet.
 *
 * Server-side only. AGENT_PRIVATE_KEY is read from the environment and the signing
 * client is constructed here; nothing in this file may be imported into a client
 * component, and the constructor refuses to run in a browser as a backstop.
 */

export interface RealAdapterConfig {
  vaultAddress: Address;
  agentPrivateKey: `0x${string}`;
  rpcUrl?: string;
}

/** Warn below this balance. At ~1,200 tx/hour a faucet-funded wallet empties quickly. */
export const LOW_BALANCE_WARN_WEI = parseEther("0.1");

/**
 * True only for a revert that decoded to `EpochNotAnchored`.
 *
 * Matched on the decoded error name, never on message text: viem wraps a revert in
 * two or three layers of `BaseError`, and string-matching would swallow an RPC
 * outage as a missing anchor and show a confidently wrong dashboard. `walk` finds
 * the decoded revert inside the wrapping; anything that is not one falls through to
 * the caller and surfaces as the failure it actually is.
 */
export function isEpochNotAnchored(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return (
    revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "EpochNotAnchored"
  );
}

export class RealAdapter implements FullAdapter {
  readonly isMock = false;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly vaultAddress: Address;

  /** Accumulated from real receipts. Never a constant — the dashboard's
   *  Monad-vs-Ethereum counter is computed from exactly these two numbers, and a
   *  judge will ask where they came from. */
  private txCount = 0;
  private totalGas = 0n;

  constructor(config: RealAdapterConfig) {
    if (typeof window !== "undefined") {
      throw new Error("RealAdapter is server-side only: the agent key must never reach a browser");
    }

    this.vaultAddress = config.vaultAddress;
    this.account = privateKeyToAccount(config.agentPrivateKey);

    const transport = http(config.rpcUrl ?? MONAD_RPC_URL);
    this.publicClient = createPublicClient({chain: monadTestnet, transport});
    this.walletClient = createWalletClient({
      account: this.account,
      chain: monadTestnet,
      transport,
    });
  }

  /**
   * Builds an adapter from the environment. Throws with a specific message rather
   * than constructing a half-configured client that fails on the first tick.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): RealAdapter {
    const vaultAddress = env.VAULT_ADDRESS;
    const agentPrivateKey = env.AGENT_PRIVATE_KEY;

    if (!vaultAddress) throw new Error("VAULT_ADDRESS is not set");
    if (!agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is not set");
    if (!agentPrivateKey.startsWith("0x")) {
      throw new Error("AGENT_PRIVATE_KEY must be 0x-prefixed");
    }

    return new RealAdapter({
      vaultAddress: vaultAddress as Address,
      agentPrivateKey: agentPrivateKey as `0x${string}`,
      rpcUrl: env.MONAD_RPC_URL,
    });
  }

  /* ------------------------------- ChainAdapter ------------------------------ */

  /**
   * One RPC call, via the contract's `getState()`. The agent polls every second or
   * two; reading weights, value, halted, and rates separately would be four
   * round-trips per poll against a public endpoint, which is how you get
   * rate-limited off a free tier.
   *
   * `getState` reverts if the current epoch has no readable anchor, because it
   * reads `strategyRates()`. In practice that is the window between a fresh deploy
   * and the first rebalance, and it is narrow — but a revert in the polling path is
   * a dead dashboard on stage, so it is caught rather than propagated. Only the
   * rates are unavailable in that case; weights, value and the halted flag still
   * matter and are still fetched, so the fallback re-reads them individually rather
   * than blanking the UI.
   */
  async getState(): Promise<VaultState> {
    try {
      const [weights, bookValue, halted, rates] = await this.publicClient.readContract({
        address: this.vaultAddress,
        abi: leashVaultAbi,
        functionName: "getState",
      });

      return {
        weights: weights.map(Number),
        totalValue: Number(formatEther(bookValue)),
        halted,
        rates: rates.map(Number),
      };
    } catch (error) {
      if (!isEpochNotAnchored(error)) throw error;
      return this.getStateWithoutRates();
    }
  }

  /**
   * The degraded read for an epoch whose market has not been drawn yet. Three calls
   * instead of one, which is fine: this path runs at most until the first rebalance
   * of an epoch lands, never in the steady state.
   *
   * `rates` comes back empty rather than zero-filled. Zeroes would render as a
   * genuine break-even market and quietly become a real-looking data point; an
   * empty array forces every consumer to decide what "no market yet" looks like.
   */
  private async getStateWithoutRates(): Promise<VaultState> {
    const [weights, bookValue, halted] = await Promise.all([
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: leashVaultAbi,
        functionName: "weights",
      }),
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: leashVaultAbi,
        functionName: "totalValue",
      }),
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: leashVaultAbi,
        functionName: "isHalted",
      }),
    ]);

    return {
      weights: weights.map(Number),
      totalValue: Number(formatEther(bookValue)),
      halted,
      rates: [],
    };
  }

  /**
   * Sends a reallocation and waits for its receipt before returning.
   *
   * Nonce strategy: await each receipt rather than run a nonce manager. Both work.
   * Awaiting serialises the wallet's transactions so `nonce too low` cannot happen,
   * and when something does go wrong it surfaces on the tick that caused it instead
   * of as a silently diverging nonce counter three minutes later. The cost is that
   * a tick blocks until the receipt lands; at Monad's ~300ms blocks that is well
   * inside the 3s tick budget, so there is nothing to buy back by pipelining.
   */
  async rebalance(weights: number[], rationaleHash: string): Promise<RebalanceReceipt> {
    const args = this.validate(weights);

    // Simulate first. A revert here costs nothing; sending a doomed transaction
    // costs gas and a tick.
    const {request} = await this.publicClient.simulateContract({
      account: this.account,
      address: this.vaultAddress,
      abi: leashVaultAbi,
      functionName: "rebalance",
      args: [args, rationaleHash as `0x${string}`],
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({hash: txHash});

    if (receipt.status !== "success") {
      throw new RebalanceRejected(`transaction ${txHash} reverted on-chain`);
    }

    this.txCount += 1;
    this.totalGas += receipt.gasUsed;

    return {txHash, gasUsed: receipt.gasUsed};
  }

  async getStats(): Promise<ChainStats> {
    return {txCount: this.txCount, totalGas: this.totalGas};
  }

  /* ------------------------------ ChainDiagnostics --------------------------- */

  async getAgentBalance(): Promise<bigint> {
    return this.publicClient.getBalance({address: this.account.address});
  }

  getAgentAddress(): string {
    return this.account.address;
  }

  getVaultAddress(): string {
    return this.vaultAddress;
  }

  async getEpoch(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vaultAddress,
      abi: leashVaultAbi,
      functionName: "currentEpoch",
    });
  }

  /* --------------------------------- Internals ------------------------------- */

  /**
   * Rejects locally what the contract would reject anyway. The bandit is supposed
   * to respect the cap on its own; this is the backstop that keeps a bug there from
   * burning a transaction per tick.
   */
  private validate(weights: number[]): readonly bigint[] {
    if (weights.length !== STRATEGY_COUNT) {
      throw new RebalanceRejected(`expected ${STRATEGY_COUNT} weights, got ${weights.length}`);
    }

    let sum = 0;
    for (const [i, w] of weights.entries()) {
      if (!Number.isInteger(w) || w < 0) {
        throw new RebalanceRejected(`weight ${i} is not a non-negative integer: ${w}`);
      }
      if (w > MAX_WEIGHT_BPS) {
        throw new RebalanceRejected(`weight ${i} of ${w} exceeds the ${MAX_WEIGHT_BPS} bps cap`);
      }
      sum += w;
    }
    if (sum !== BPS_DENOMINATOR) {
      throw new RebalanceRejected(`weights sum to ${sum}, expected ${BPS_DENOMINATOR}`);
    }

    return weights.map(BigInt);
  }
}
