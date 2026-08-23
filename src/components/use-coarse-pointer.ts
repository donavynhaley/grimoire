import { useEffect, useState } from "react";

/**
 * A window narrow enough, or a pointer blunt enough *on a screen small enough*, to be a phone.
 *
 * The width half of this matters as much as the pointer half: it is what lets the sheet be
 * seen and tested in a narrow desktop window, which is where it is actually built.
 *
 * The pointer half has to be paired with a size. A blunt pointer says a finger is holding the
 * device, not that the device is small - a touchscreen laptop, a 4K monitor with a touch
 * panel, and Chromium's own responsive mode all report a coarse pointer at desktop
 * dimensions, and each of them was getting the phone sheet across a screen with room for
 * twenty of them. 1024px keeps every phone, including landscape, and every tablet in
 * portrait, while a screen genuinely the size of a desk gets the centred dialog it should.
 *
 * Only the presentation shell reads this. The finger-sized tap targets in the stylesheet stay
 * on `(pointer: coarse)` alone, because a finger on a large touch screen is still a finger.
 */
const PHONE = "(pointer: coarse) and (max-width: 1024px), (max-width: 620px)";

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
