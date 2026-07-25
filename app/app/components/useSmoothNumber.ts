"use client";

import {useEffect, useRef, useState} from "react";

/**
 * Eases a displayed number toward its target instead of snapping to it.
 *
 * The dashboard polls once a second, so every figure on screen would otherwise jump
 * in discrete steps — which reads as a page refreshing rather than as a system
 * running. Interpolating between polls is the cheapest way to make a live surface
 * feel live, and unlike a glow it carries information: the speed of the count is the
 * size of the change.
 *
 * Deliberately not used for the block height. That one is an integer counter where
 * the exact value matters and a half-counted block would be a lie; it gets a flash
 * on change instead.
 *
 * Honours `prefers-reduced-motion` by snapping, and snaps on the first value so the
 * first paint is never a number counting up from zero.
 */
export function useSmoothNumber(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(target);

  const fromRef = useRef(target);
  const startRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!Number.isFinite(target)) return;

    // First real value, or a user who asked for less motion: no animation.
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!seededRef.current || reduced) {
      seededRef.current = true;
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    fromRef.current = display;
    startRef.current = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / durationMs);
      // Ease-out cubic: fast acknowledgement of the change, soft landing.
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(fromRef.current + (target - fromRef.current) * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
    // `display` is intentionally excluded: including it would restart the tween on
    // every frame it sets, which is an infinite loop rather than an animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}

/**
 * True for a short beat after `value` changes, for acknowledging a discrete event.
 *
 * Used by the block height: a new block is a thing that happened, and the flash is
 * the screen saying so. Motion here is always caused by real chain activity, never
 * by a timer, which is the difference between atmosphere and decoration.
 */
export function useChangeFlash(value: string, holdMs = 600): boolean {
  const [flashing, setFlashing] = useState(false);
  const previous = useRef(value);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlashing(true);
    const id = setTimeout(() => setFlashing(false), holdMs);
    return () => clearTimeout(id);
  }, [value, holdMs]);

  return flashing;
}
