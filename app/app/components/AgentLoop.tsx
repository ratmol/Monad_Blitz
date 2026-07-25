/**
 * Section 2 — "The agent observes."
 *
 * Server-rendered, no props: this is the invariant loop the agent runs regardless of
 * mode or chain state, so it costs nothing to draw before any data arrives. The one
 * moving part is a single pulse tracing the ring via `offset-path` (see `.loop-pulse`
 * in globals.css) — four nodes lit in sequence would be four competing animations;
 * one dot on a fixed track reads as one continuous process instead.
 */
const STEPS = [
  {label: "Market", angle: -90, note: "reads the vault's current epoch rates"},
  {label: "Reward", angle: 0, note: "scores the last allocation's realised return"},
  {label: "Decision", angle: 90, note: "bandit picks the next weights, explore or exploit"},
  {label: "Execution", angle: 180, note: "sends rebalance(), waits for the receipt"},
] as const;

const CX = 200;
const CY = 200;
const R = 148;

function pointOn(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {x: CX + R * Math.cos(rad), y: CY + R * Math.sin(rad)};
}

const RING_PATH = `M ${CX + R} ${CY} A ${R} ${R} 0 1 1 ${CX - R} ${CY} A ${R} ${R} 0 1 1 ${CX + R} ${CY}`;

export function AgentLoop() {
  return (
    <section id="loop" className="snap-section relative flex min-h-screen flex-col justify-center px-6 py-24 sm:px-10 lg:px-16">
      <div className="mx-auto grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim">
            Every 3 seconds
          </div>
          <h2 className="display mt-3 text-[13vw] text-foreground sm:text-6xl">
            The agent
            <br />
            observes.
          </h2>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-muted">
            No step here is optional and none is skipped for a demo. The same four moves
            run whether the market rewarded the last decision or punished it — that
            consistency is what &quot;learning&quot; means here, not a figure of speech.
          </p>
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[420px]">
          <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border-subtle)" strokeWidth="1" />
            <circle
              className="loop-pulse"
              r="4.5"
              fill="var(--accent)"
              style={{offsetPath: `path('${RING_PATH}')`} as React.CSSProperties}
            />
          </svg>

          {STEPS.map((step) => {
            const {x, y} = pointOn(step.angle);
            return (
              <div
                key={step.label}
                className="absolute flex w-32 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-center"
                style={{left: `${(x / 400) * 100}%`, top: `${(y / 400) * 100}%`}}
              >
                <span className="rounded-full border border-border-subtle bg-surface px-3 py-1 text-[12px] font-semibold text-foreground">
                  {step.label}
                </span>
                <span className="text-[10px] leading-snug text-muted-dim">{step.note}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
