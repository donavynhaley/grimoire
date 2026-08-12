import { useEffect, useRef } from "react";

/**
 * Closes a dialog on Escape.
 *
 * Nested controls that answer Escape themselves - the notes editor leaving edit mode,
 * a dependency search closing its results - stop the event, so the dialog only hears
 * the presses nothing else wanted.
 */
export function useDialogEscape(close: () => void | Promise<void>): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void closeRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);
}
