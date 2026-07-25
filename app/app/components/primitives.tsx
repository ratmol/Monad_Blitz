import type {ReactNode} from "react";

/** Shared shell so every panel lines up and nothing drifts a pixel during the demo. */
export function Panel({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col rounded-xl border border-border-subtle bg-surface p-5 ${className}`}
    >
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "agent" | "gain" | "loss" | "warn";
  hint?: string;
}) {
  const toneClass = {
    neutral: "text-foreground",
    agent: "text-agent",
    gain: "text-gain",
    loss: "text-loss",
    warn: "text-warn",
  }[tone];

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-muted">{label}</div>
      <div className={`tabular mt-1 text-3xl font-bold ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "agent" | "gain" | "loss" | "warn";
}) {
  const toneClass = {
    neutral: "border-border-subtle text-muted",
    agent: "border-agent text-agent",
    gain: "border-gain text-gain",
    loss: "border-loss text-loss",
    warn: "border-warn text-warn",
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-widest ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function formatMon(value: number): string {
  return value.toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 4});
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

export function formatBps(bps: number): string {
  const sign = bps > 0 ? "+" : "";
  return `${sign}${bps.toFixed(0)} bps`;
}
