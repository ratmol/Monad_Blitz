/** Section 7 — the close. Three links, nothing invented. */
export function CTA({vaultLink, agentLink}: {vaultLink: string | null; agentLink: string | null}) {
  return (
    <section className="snap-section relative flex min-h-[70vh] flex-col items-center justify-center px-6 py-24 text-center sm:px-10">
      <h2 className="display text-[13vw] text-foreground sm:text-6xl">
        Ready to leash
        <br />
        your AI?
      </h2>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <a
          href="#dashboard"
          className="rounded-lg bg-agent px-6 py-2.5 text-[13px] font-semibold text-background transition-transform hover:scale-[1.02]"
        >
          Launch App
        </a>
        <a
          href="https://github.com/ratmol/Monad_Blitz"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-border-subtle px-6 py-2.5 text-[13px] font-semibold text-foreground transition-colors hover:border-border-strong"
        >
          GitHub
        </a>
        {vaultLink ? (
          <a
            href={vaultLink}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border-subtle px-6 py-2.5 text-[13px] font-semibold text-foreground transition-colors hover:border-border-strong"
          >
            View on Monad
          </a>
        ) : null}
      </div>

      {agentLink ? (
        <p className="mt-8 text-[11px] text-muted-dim">
          The agent has no path to your funds — see for yourself.
        </p>
      ) : null}
    </section>
  );
}
