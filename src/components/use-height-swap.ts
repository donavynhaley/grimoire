import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION = 190;
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const THRESHOLD = 1;

/**
 * Grows and shrinks a box between the sizes of whatever it swaps between.
 *
 * A field that rests as rendered text and edits as a fixed-height textarea changes
 * size the instant it is clicked, which reads as the panel snapping open under the
 * pointer. Measuring after each render and replaying the previous height keeps the
 * opening continuous, and because the animation drives real layout rather than a
 * transform, everything below it travels along instead of jumping ahead.
 *
 * Height is clipped only while the animation runs, so a focus ring around the
 * control inside is never cut off once it settles.
 */
export function useHeightSwap(container: RefObject<HTMLElement | null>): void {
  const previous = useRef<number | null>(null);
  const running = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const height = node.offsetHeight;
    const before = previous.current;
    previous.current = height;

    // The first paint has nothing to grow from, and a settled box has nowhere to go.
    if (before === null || Math.abs(before - height) < THRESHOLD) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced || typeof node.animate !== "function") return;

    running.current?.cancel();
    node.style.overflow = "hidden";
    const animation = node.animate(
      [{ height: `${before}px` }, { height: `${height}px` }],
      { duration: DURATION, easing: EASING },
    );
    running.current = animation;

    // A cancel arrives after the replacement has claimed the ref, so only the
    // animation still holding it may hand the box back to the stylesheet.
    const settle = () => {
      if (running.current !== animation) return;
      node.style.removeProperty("overflow");
      running.current = null;
    };
    animation.addEventListener("finish", settle);
    animation.addEventListener("cancel", settle);
  });
}
