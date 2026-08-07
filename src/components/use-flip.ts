import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION = 190;
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const THRESHOLD = 1;

type Placement = { left: number; top: number; laidOut: boolean };

/**
 * Slides elements from where they used to be to where they now are.
 *
 * Drag hints, drops, and filter changes all reorder a list in a single render, which
 * otherwise teleports every neighbour to its new place. Measuring after each render
 * and replaying the delta keeps the movement continuous without holding any layout
 * state in React.
 *
 * Elements opt in with a stable `data-flip-id`. Positions come from layout offsets
 * rather than viewport rectangles so that scrolling a column, or the page, never
 * looks like movement worth animating. Hidden elements have no layout box and are
 * skipped until they are placed again.
 */
export function useFlip(container: RefObject<HTMLElement | null>): void {
  const previous = useRef(new Map<string, Placement>());
  const running = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const measured = new Map<string, Placement>();

    for (const node of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = node.dataset.flipId;
      if (!id) continue;
      const placement = placementOf(node);
      measured.set(id, placement);
      if (reduced || typeof node.animate !== "function") continue;

      const before = previous.current.get(id);
      if (!before?.laidOut || !placement.laidOut) continue;
      const dx = before.left - placement.left;
      const dy = before.top - placement.top;
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) continue;

      running.current.get(id)?.cancel();
      const animation = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: DURATION, easing: EASING },
      );
      running.current.set(id, animation);
      animation.addEventListener("finish", () => {
        if (running.current.get(id) === animation) running.current.delete(id);
      });
    }

    for (const [id, animation] of running.current) {
      if (measured.has(id)) continue;
      animation.cancel();
      running.current.delete(id);
    }
    previous.current = measured;
  });
}

function placementOf(node: HTMLElement): Placement {
  let left = node.offsetLeft;
  let top = node.offsetTop;
  const laidOut = node.offsetWidth > 0 || node.offsetHeight > 0;
  // Walk to a common origin so a card keeps the same coordinate space when it moves
  // between columns, which are separate offset parents once anything is positioned.
  for (let parent = node.offsetParent; parent instanceof HTMLElement; parent = parent.offsetParent) {
    left += parent.offsetLeft;
    top += parent.offsetTop;
  }
  return { left, top, laidOut };
}
