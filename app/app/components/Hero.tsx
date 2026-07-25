"use client";

import {useEffect, useRef} from "react";

/**
 * The one signature moment of the whole page.
 *
 * A tether runs between two nodes, AGENT and VAULT. At rest it hangs with slack — a
 * loose catenary, the agent free to move within it. As the page scrolls past the
 * hero, the line pulls taut and holds straight: the exact shape of the project's
 * actual claim (room to act, a limit it cannot leave). One scroll listener writes a
 * `--tension` custom property (0 to 1) on the section; two overlaid SVG paths
 * crossfade off that property in CSS, so the only per-frame work is a style write,
 * not a re-render.
 */
export function Hero() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    let raf = 0;

    function update() {
      raf = 0;
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      // 0 while the hero fills the viewport, 1 once it has scrolled fully past.
      const progress = Math.min(1, Math.max(0, -rect.top / (rect.height - viewport * 0.4)));
      el.style.setProperty("--tension", progress.toFixed(3));
    }

    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(update);
    }

    update();
    window.addEventListener("scroll", onScroll, {passive: true});
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="snap-section relative flex min-h-screen flex-col justify-between overflow-hidden px-6 pb-10 pt-28 sm:px-10 lg:px-16"
      style={{"--tension": 0} as React.CSSProperties}
    >
      <TetherField />

      <div className="relative z-10 max-w-3xl">
        <h1 className="display text-[15vw] text-foreground sm:text-[9vw] lg:text-[110px]">
          Leash
          <br />
          your AI.
        </h1>

        <p className="mt-6 max-w-md text-[15px] leading-relaxed text-muted sm:text-base">
          An autonomous trading agent that learns, adapts, and executes on Monad — inside
          limits enforced by a smart contract it does not have the keys to break.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a
            href="#dashboard"
            className="rounded-lg bg-agent px-5 py-2.5 text-[13px] font-semibold text-background transition-transform hover:scale-[1.02]"
          >
            Launch Agent
          </a>
          <a
            href="#loop"
            className="rounded-lg border border-border-subtle px-5 py-2.5 text-[13px] font-semibold text-foreground transition-colors hover:border-border-strong"
          >
            Watch it decide
          </a>
        </div>
      </div>

      <a
        href="#loop"
        className="relative z-10 flex items-center gap-2 self-start text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim transition-colors hover:text-muted"
      >
        <span aria-hidden>↓</span> Scroll
      </a>
    </section>
  );
}

/**
 * The tether itself: two nodes and two crossfading paths between them. Positioned in
 * a fixed viewBox so it reads the same on a phone and an ultrawide — the paths are
 * drawn generously past the visible edges rather than stretched, since a stretched
 * catenary looks like an error, not a rope.
 */
function TetherField() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <path
        className="tether-slack"
        d="M 120 180 Q 500 460 880 180"
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
        strokeDasharray="2 8"
        strokeLinecap="round"
      />
      <path
        className="tether-taut"
        d="M 120 180 L 880 180"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      <g className="tether-node" style={{transformOrigin: "120px 180px"}}>
        <circle cx="120" cy="180" r="5" fill="var(--accent)" />
        <text
          x="120"
          y="205"
          textAnchor="middle"
          className="mono"
          fontSize="11"
          fill="var(--muted-dim)"
          letterSpacing="1.5"
        >
          AGENT
        </text>
      </g>
      <g className="tether-node" style={{transformOrigin: "880px 180px"}}>
        <circle cx="880" cy="180" r="5" fill="var(--foreground)" />
        <text
          x="880"
          y="205"
          textAnchor="middle"
          className="mono"
          fontSize="11"
          fill="var(--muted-dim)"
          letterSpacing="1.5"
        >
          VAULT
        </text>
      </g>
    </svg>
  );
}
