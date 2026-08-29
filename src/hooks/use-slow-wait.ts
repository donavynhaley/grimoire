import { useEffect, useState } from "react";

/**
 * How long a wait may run before it is worth telling anybody about.
 *
 * Under this, an indicator is a flash rather than an answer: it paints and is
 * gone again before the eye has resolved it, which reads as the interface
 * glitching rather than as work being done.
 */
const SLOW_AFTER_MS = 200;

/**
 * Whether a wait has gone on long enough to be worth showing.
 *
 * A loader raised the instant work starts flickers on every fast connection and
 * every small board. Holding it back until the wait is genuinely slow means the
 * quick case shows nothing at all, which is what quick is supposed to look like.
 */
export function useSlowWait(waiting: boolean, afterMs: number = SLOW_AFTER_MS): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [waiting, afterMs]);

  // Read against `waiting` rather than returned bare, so an answer arriving late still
  // takes the indicator away in the same render it arrives in. Left to the effect below,
  // the indicator would outlive the wait by a commit and flicker on its way out.
  return waiting && slow;
}
