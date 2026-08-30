import { useCallback, useEffect, useState } from "react";
import type { AwayState } from "../../shared/types";
import { away as loadAway, markSeen } from "../api/client";

/**
 * The while-you-were-away boundary, captured once per project session.
 *
 * What the digest and markers show stays stable for the whole visit even as the seen
 * cursor advances behind it. Advancing happens only while the tab is actually on
 * screen: a board reloading behind a hidden tab stays unseen, so it can greet the
 * reader on their next visit instead of silently slipping past them.
 */
export function useAwayState(
  active: boolean,
  projectId: string | undefined,
): { awayState: AwayState | null; advanceSeen: () => void } {
  const [awayState, setAwayState] = useState<AwayState | null>(null);

  const advanceSeen = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    markSeen().catch(() => {
      // A missed advance only means the same changes greet the reader again.
    });
  }, []);

  useEffect(() => {
    if (!active || !projectId) return;
    let alive = true;
    setAwayState(null);
    loadAway()
      .then((value) => {
        if (!alive) return;
        setAwayState(value);
        advanceSeen();
      })
      .catch(() => {
        // The board works without its welcome-back decoration.
      });
    return () => {
      alive = false;
    };
  }, [active, advanceSeen, projectId]);

  useEffect(() => {
    if (!active) return;
    const onVisibilityChange = () => advanceSeen();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [active, advanceSeen]);

  return { awayState, advanceSeen };
}
