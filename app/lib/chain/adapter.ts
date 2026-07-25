import {keccak256, toHex} from "viem";

/**
 * The seam.
 *
 * Everything above this line — the bandit, the agent loop, the dashboard — is
 * written against `ChainAdapter` and never imports viem or an ABI directly. That
 * keeps the whole system runnable and testable with no chain connection, and it
 * means swapping the mock for the real Monad adapter is a one-line change.
 */

export interface VaultState {
  /** Current allocation in basis points, one entry per strategy. Sums to 10000. */
  weights: number[];
  /** Book value in whole MON. See the note on precision below. */
  totalValue: number;
  /** True once the drawdown breaker has fired. The agent is locked out. */
  halted: boolean;
  /** This epoch's return per strategy, in bps, signed. Zero is break-even. */
  rates: number[];
}

export interface RebalanceReceipt {
  txHash: string;
  gasUsed: bigint;
}

export interface ChainStats {
  txCount: number;
  totalGas: bigint;
}

/**
 * Precision note: `totalValue` is a `number` of whole MON, not wei. The contract
 * works in wei and the adapters keep wei internally; the conversion happens at
 * this boundary because the value is only ever charted and compared, never used
 * to compute a transfer. Gas stays `bigint` because it is summed and displayed
 * exactly.
 */
export interface ChainAdapter {
  getState(): Promise<{ weights: number[]; totalValue: number; halted: boolean; rates: number[] }>;
  rebalance(weights: number[], rationaleHash: string): Promise<{ txHash: string; gasUsed: bigint }>;
  getStats(): Promise<{ txCount: number; totalGas: bigint }>;
}

/**
 * Operational reads that are not part of the seam because the agent loop wants
 * them for logging, not for deciding. Kept separate so `ChainAdapter` stays
 * exactly the interface both sides agreed on.
 */
export interface ChainDiagnostics {
  /** Agent wallet balance in wei. Drains fast at ~1,200 tx/hour. */
  getAgentBalance(): Promise<bigint>;
  /** Address the adapter signs with, or a synthetic one for the mock. */
  getAgentAddress(): string;
  /** Deployed vault address, or a synthetic one for the mock. */
  getVaultAddress(): string;
}

export type FullAdapter = ChainAdapter & ChainDiagnostics;

/** Thrown when the contract would reject a reallocation, before it is sent. */
export class RebalanceRejected extends Error {
  constructor(readonly reason: string) {
    super(`rebalance rejected: ${reason}`);
    this.name = "RebalanceRejected";
  }
}

/**
 * The seam's mirror of `LeashVault.EpochNotAnchored`.
 *
 * An epoch's market is derived from the hash of the block before it began, so a
 * rate only exists once that block is mined. Reads for a future epoch — or for a
 * past one nobody ever rebalanced in, whose hash has since aged out of the EVM's
 * 256 block window — revert rather than invent a number. Both adapters raise this
 * so callers above the seam handle one failure, not two.
 */
export class EpochNotAnchored extends Error {
  constructor(readonly epoch: bigint) {
    super(`epoch ${epoch} is not anchored: its market has not been drawn yet`);
    this.name = "EpochNotAnchored";
  }
}

/**
 * Hashes the agent's stated reason for a decision. Only the hash goes on-chain;
 * the text lives off-chain, and anyone holding it can verify it against the log.
 */
export function rationaleHash(text: string): `0x${string}` {
  return keccak256(toHex(text));
}
