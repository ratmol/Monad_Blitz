"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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
 */
export function RaceChart({history}: {history: TickRecord[]}) {
  const data = history.map((tick, i) => ({
    i,
    agent: tick.agentValue,
    baseline: tick.baselineValue,
  }));

  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-muted">
        Waiting for the first tick…
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{top: 8, right: 12, bottom: 4, left: 4}}>
          <CartesianGrid stroke="#262633" vertical={false} />
          <XAxis dataKey="i" stroke="#a3a3b8" tick={{fontSize: 12}} tickLine={false} />
          <YAxis
            stroke="#a3a3b8"
            tick={{fontSize: 12}}
            tickLine={false}
            width={72}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{
              background: "#12121a",
              border: "1px solid #262633",
              borderRadius: 8,
              color: "#f4f4f6",
            }}
            formatter={(value, name) => [`${formatMon(Number(value))} MON`, String(name)]}
            labelFormatter={(label) => `tick ${String(label)}`}
          />
          <Legend wrapperStyle={{fontSize: 13, paddingTop: 8}} />
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
            stroke="#8a8a9e"
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
