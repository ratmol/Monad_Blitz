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
 *
 * The Monad gas price is measured, not guessed: `cast gas-price` against
 * testnet-rpc.monad.xyz returned 102 gwei on 2026-07-25. Re-check it on demo day —
 * it feeds the MON burn rate, which is what actually drains the faucet wallet.
 */
export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  ethereumGasPriceGwei: 8,
  ethereumPriceUsd: 3_000,
  monadGasPriceGwei: 102,
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
  /** MON actually burned so far. */
  monadMon: number;
  /**
   * MON burned per hour at the strategy's real cadence. This is the operational
   * number, not a pitch number: it is what empties the faucet-funded agent wallet
   * mid-demo, and it is the one to check a balance against before pitching.
   */
  monadMonPerHour: number;
  assumptions: CostAssumptions;
}

/** Transactions per hour at a 3s tick, from the build plan's economics argument. */
export const TX_PER_HOUR = 1_200;
const TX_PER_DAY = TX_PER_HOUR * 24;

/** Gas units × price in gwei → whole tokens. */
function tokens(gasUnits: number, gasPriceGwei: number): number {
  return gasUnits * gasPriceGwei * 1e-9;
}

function usd(gasUnits: number, gasPriceGwei: number, tokenPriceUsd: number): number {
  return tokens(gasUnits, gasPriceGwei) * tokenPriceUsd;
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
    monadMon: tokens(gas, assumptions.monadGasPriceGwei),
    monadMonPerHour: tokens(gasPerTx * TX_PER_HOUR, assumptions.monadGasPriceGwei),
    assumptions,
  };
}
