import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

/** How a settings section runs a mutation: the shell shows the outcome, the section only acts. */
export type SettingsRun = (change: () => Promise<void>, failure: string) => Promise<void>;

/**
 * One outcome surface for the whole settings dialog.
 *
 * Every section used to carry its own copy of an eight-line error closure, and none of them
 * ever confirmed success. This hook is the single replacement: sections call `run`, and the
 * shell renders one error strip and one quiet "saved" acknowledgment in one fixed place -
 * so an edit that auto-saved is visibly saved, and a refusal is never printed twice.
 */
export function useSettingsAction(): { error: string; saved: boolean; run: SettingsRun } {
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  const run: SettingsRun = async (change, failure) => {
    setError("");
    setSaved(false);
    window.clearTimeout(savedTimer.current);
    try {
      await change();
      setSaved(true);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (value) {
      setError(value instanceof ApiError ? value.message : failure);
    }
  };

  return { error, saved, run };
}
