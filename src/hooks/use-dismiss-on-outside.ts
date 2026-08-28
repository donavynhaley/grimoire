import { type RefObject, useEffect, useRef } from "react";

/**
 * Closes a popover when the pointer goes down anywhere outside it.
 *
 * Clicking away is the ordinary way out of a popover, and the one people reach for before
 * they find the close it covers. The dismiss goes through a ref so a caller can hand in a
 * fresh closure every render without the document listener churning while the popover is up.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  dismiss: () => void,
): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismissRef.current();
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open, ref]);
}
