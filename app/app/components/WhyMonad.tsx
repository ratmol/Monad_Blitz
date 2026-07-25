import {formatUsd} from "./primitives";

/**
 * Section 6 — the chain-specific argument, made with the run's own numbers rather
 * than a generic checkmark table. `cost` comes straight from `compareCost()`: gas
 * *units* are real receipts, only the two prices are stated assumptions, and both are
 * printed so the claim is checkable instead of asserted.
 */
export function WhyMonad({
  cost,
}: {
  cost: {
    ethereumUsdPerDay: number;
    monadUsdPerDay: number;
    assumptions: {ethereumGasPriceGwei: number; monadGasPriceGwei: number};
  };
}) {
  const impossible = cost.ethereumUsdPerDay > 0;

  return (
    <section className="snap-section relative flex min-h-screen flex-col justify-center px-6 py-24 sm:px-10 lg:px-16">
      <div className="mx-auto w-full max-w-4xl">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim">
          Same strategy, two chains
        </div>
        <h2 className="display mt-3 text-[13vw] text-foreground sm:text-6xl">Why Monad.</h2>
        <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-muted">
          Rebalancing every three seconds is roughly 1,200 transactions an hour. The
          gas *units* below are this run&apos;s real receipts — only the price per gas
          is an assumption, and it is stated so you can argue with it.
        </p>

        <div className="mt-14 grid gap-8 sm:grid-cols-2">
          <div className="border-l-2 border-border-subtle pl-6">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-dim">
              Ethereum L1 · {cost.assumptions.ethereumGasPriceGwei} gwei
            </div>
            <div className="mono mt-2 text-4xl font-medium text-baseline line-through decoration-2 sm:text-5xl">
              {formatUsd(cost.ethereumUsdPerDay)}
            </div>
            <div className="mt-2 text-[13px] text-muted-dim">per day, at this tick rate</div>
            {impossible ? (
              <p className="mt-4 text-[13px] leading-relaxed text-muted">
                The strategy spends more than it can plausibly earn. Not slow — uneconomic.
              </p>
            ) : null}
          </div>

          <div className="border-l-2 border-agent pl-6">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-dim">
              Monad testnet · {cost.assumptions.monadGasPriceGwei} gwei
            </div>
            <div className="mono mt-2 text-4xl font-medium text-agent sm:text-5xl">
              {formatUsd(cost.monadUsdPerDay)}
            </div>
            <div className="mt-2 text-[13px] text-muted-dim">per day, at this tick rate</div>
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              Sub-second blocks and negligible fees are what make acting this often
              routine rather than remarkable.
            </p>
          </div>
        </div>

        <p className="mt-14 max-w-2xl text-[13px] leading-relaxed text-muted-dim">
          Parallel execution, low latency, full EVM compatibility — none of that matters
          for this project on its own. What matters is that they add up to a chain an
          untrusted agent can act on every few seconds without the fee eating the
          strategy alive.
        </p>
      </div>
    </section>
  );
}
