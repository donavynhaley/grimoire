import { type RefObject, useLayoutEffect, useRef } from "react";

const DURATION = 190;
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const THRESHOLD = 1;

/**
 * Grows and shrinks a box between the sizes of whatever it holds.
 *
 * A section that unfolds, or a field that rests as rendered text and edits as a
 * fixed-height textarea, changes size the instant it is clicked, which reads as the
 * panel snapping open under the pointer. Measuring after each render and replaying
 * the previous height keeps the opening continuous, and because the animation drives
 * real layout rather than a transform, everything below it travels along instead of
 * jumping ahead.
 *
 * A render arriving mid-flight — an autosave settling, a search result landing —
 * takes over from wherever the box currently looks, so the motion continues to the
 * new size rather than snapping back to a size it never reached. Reading the target
 * means handing layout back first, which is why the running animation is cancelled
 * before the measurement rather than after it.
 *
 * Height is clipped only while the animation runs, so a focus ring around a control
 * inside is never cut off once it settles.
 */
export function useHeightSwap(container: RefObject<HTMLElement | null>): void {
  const previous = useRef<number | null>(null);
  const running = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;

    // While an animation runs the box measures wherever it has travelled to, which is
    // where the next one has to start from. Cancelling hands the height back to the
    // stylesheet so the following measurement is the size being aimed at.
    const from = running.current ? node.offsetHeight : previous.current;
    running.current?.cancel();
    const target = node.offsetHeight;
    previous.current = target;

    // The first paint has nothing to grow from, and a settled box has nowhere to go.
    if (from === null || Math.abs(from - target) < THRESHOLD) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced || typeof node.animate !== "function") return;

    node.style.overflow = "hidden";
    const animation = node.animate([{ height: `${from}px` }, { height: `${target}px` }], {
      duration: DURATION,
      easing: EASING,
    });
    running.current = animation;

    // A cancel arrives after its replacement has claimed the ref, so only the
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
