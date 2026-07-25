"use client";

import {
  CartesianGrid,
  Label,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {TickRecord} from "../../lib/agent/loop";
import {formatMon} from "./primitives";

/**
 * The whole "it is learning" claim, in one picture.
 *
 * Two lines, same market, same tick cadence, same settlement arithmetic — the only
 * difference between them is the allocation policy. That is what makes the gap
 * attributable to learning rather than to luck or to simply trading more often, and
 * it is why the baseline is drawn as a flat grey control rather than as a rival.
 *
 * The baseline is simulated (there is one vault and one agent role), and the axis
 * label says so. An unlabelled simulated comparison is the kind of thing that makes
 * a judge discount everything else on screen.
 *
 * ## Why the epoch markers matter more than they look
 *
 * At every marker the market was redrawn from a fresh block hash and the bandit's
 * estimates were wiped, so the ticks immediately after one are a deliberate sweep of
 * arms the agent has no reading on yet. Without the marker that stretch reads as the
 * agent faltering. With it, the same pixels read as what they are: the cost of
 * finding out, paid once per market, followed by the agent pulling away again.
 */
export function RaceChart({
  history,
  epochBoundaries,
}: {
  history: TickRecord[];
  epochBoundaries: number[];
}) {
  const data = history.map((tick, i) => ({
    i,
    agent: tick.agentValue,
    baseline: tick.baselineValue,
  }));

  if (data.length === 0) {
    return (
      <div className="flex h-[22rem] items-center justify-center text-muted">
        Waiting for the first tick…
      </div>
    );
  }

  return (
    <div className="h-[22rem] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{top: 16, right: 16, bottom: 4, left: 4}}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          {/* A 200-tick rolling window would otherwise print a label every few pixels
              and turn the axis into noise at projector distance. */}
          <XAxis
            dataKey="i"
            stroke="#5e636e"
            tick={{fontSize: 13}}
            tickLine={false}
            minTickGap={48}
          />
          <YAxis
            stroke="#5e636e"
            tick={{fontSize: 13}}
            tickLine={false}
            width={78}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(2)}
          />

          {/* Only the first marker carries the label. Repeating it at every boundary
              turns a legible chart into a wall of text on a projector. */}
          {epochBoundaries.map((index, n) => (
            <ReferenceLine key={index} x={index} stroke="#e3a008" strokeDasharray="3 4">
              {n === 0 ? (
                <Label
                  value="new market — bandit resets"
                  position="insideTopLeft"
                  fill="#e3a008"
                  fontSize={12}
                />
              ) : null}
            </ReferenceLine>
          ))}

          <Tooltip
            contentStyle={{
              background: "#13151a",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 10,
              color: "#ededef",
              fontSize: 13,
            }}
            formatter={(value, name) => [`${formatMon(Number(value))} MON`, String(name)]}
            labelFormatter={(label) => `tick ${String(label)}`}
          />
          <Legend wrapperStyle={{fontSize: 14, paddingTop: 8}} />
          <Line
            type="monotone"
            dataKey="agent"
            name="LEASH agent"
            stroke="#836ef9"
            strokeWidth={3}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="baseline"
            name="Even-split baseline (simulated)"
            stroke="#6e7381"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
