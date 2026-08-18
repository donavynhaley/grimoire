import { useEffect, useState } from "react";

/**
 * A window narrow enough, or a pointer blunt enough, to be a phone.
 *
 * The width half of this matters as much as the pointer half: it is what lets the sheet be
 * seen and tested in a narrow desktop window, which is where it is actually built.
 */
const PHONE = "(pointer: coarse), (max-width: 620px)";

/**
 * Whether the interface should present itself for a thumb.
 *
 * Defaults to false, which is the desktop presentation, so a browser without `matchMedia` -
 * jsdom, most notably - renders exactly what it rendered before any of this existed.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => window.matchMedia?.(PHONE).matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const answer = () => setCoarse(query.matches);
    answer();
    // Rotating a phone, or dragging a desktop window narrow, changes the answer mid-visit.
    query.addEventListener("change", answer);
    return () => query.removeEventListener("change", answer);
  }, []);

  return coarse;
}
