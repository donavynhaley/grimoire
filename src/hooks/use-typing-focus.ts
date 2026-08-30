import { type RefCallback, useCallback, useRef } from "react";

/**
 * Focuses a field on arrival, unless doing so would put a keyboard over the thing being read.
 *
 * `autoFocus` was on the board's capture field, the garden's capture field, and the search box
 * of every library that has one. On a desktop that is right: the caret lands where typing was
 * going to start anyway. On a phone it means the keyboard rises over half the board the moment
 * it loads, and over the backlog the moment it is opened to be browsed.
 *
 * The distinction is not the device, it is what the surface is for. Somewhere whose only
 * purpose is a query - the search drawer - should still take the keyboard on a phone, so it
 * passes `always`. Everywhere the reader came to look first, focus waits to be asked for.
 */
export function useTypingFocus<T extends HTMLElement>(options: { always?: boolean } = {}): RefCallback<T> {
  const { always = false } = options;
  const claimed = useRef(false);

  return useCallback(
    (node: T | null) => {
      // A ref callback runs again on every re-render this element survives; the field should
      // only be claimed when it first appears, never stolen back mid-edit.
      if (!node || claimed.current) return;
      claimed.current = true;
      const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      if (coarse && !always) return;
      node.focus({ preventScroll: true });
    },
    [always],
  );
}
