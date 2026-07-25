/**
 * The Monad-vs-Ethereum cost comparison.
 *
 * This is the project's strongest chain-specific claim, so the numbers behind it are
 * assumptions with names and sources rather than a hardcoded "$14,000". Every one of
 * them is overridable, and the UI shows what was used. A judge who asks "where does
 * that figure come from" gets an answer instead of a shrug.
 *
 * The gas *units* are never assumed — they come from real receipts via
 * `ChainAdapter.getStats()`. Only the prices below are estimates.
 */

export interface CostAssumptions {
  /** Ethereum L1 base+priority fee, gwei. Varies enormously; state what you used. */
  ethereumGasPriceGwei: number;
  /** ETH spot, USD. */
  ethereumPriceUsd: number;
  /** Monad testnet has no market price. Mainnet fees are the argument; this is a placeholder. */
  monadGasPriceGwei: number;
  monadPriceUsd: number;
}

/**
 * Deliberately conservative on the Ethereum side. The argument does not need a gas
 * spike to work, and picking a peak number invites "you cherry-picked congestion".
 */
export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  ethereumGasPriceGwei: 8,
  ethereumPriceUsd: 3_000,
  monadGasPriceGwei: 50,
  monadPriceUsd: 0.01,
};

export interface CostComparison {
  txCount: number;
  totalGas: bigint;
  /** Gas units per rebalance, averaged over real receipts. */
  gasPerTx: number;
  monadUsd: number;
  ethereumUsd: number;
  /** Extrapolated to the pitch's 1,200 tx/hour, 24 hours. */
  ethereumUsdPerDay: number;
  monadUsdPerDay: number;
  assumptions: CostAssumptions;
}

/** Transactions per hour at a 3s tick, from the build plan's economics argument. */
export const TX_PER_HOUR = 1_200;
const TX_PER_DAY = TX_PER_HOUR * 24;

function usd(gasUnits: number, gasPriceGwei: number, tokenPriceUsd: number): number {
  return (gasUnits * gasPriceGwei * 1e-9) * tokenPriceUsd;
}

export function compareCost(
  txCount: number,
  totalGas: bigint,
  assumptions: CostAssumptions = DEFAULT_ASSUMPTIONS,
): CostComparison {
  const gas = Number(totalGas);
  const gasPerTx = txCount === 0 ? 0 : gas / txCount;

  return {
    txCount,
    totalGas,
    gasPerTx,
    monadUsd: usd(gas, assumptions.monadGasPriceGwei, assumptions.monadPriceUsd),
    ethereumUsd: usd(gas, assumptions.ethereumGasPriceGwei, assumptions.ethereumPriceUsd),
    ethereumUsdPerDay: usd(
      gasPerTx * TX_PER_DAY,
      assumptions.ethereumGasPriceGwei,
      assumptions.ethereumPriceUsd,
    ),
    monadUsdPerDay: usd(
      gasPerTx * TX_PER_DAY,
      assumptions.monadGasPriceGwei,
      assumptions.monadPriceUsd,
    ),
    assumptions,
  };
}
