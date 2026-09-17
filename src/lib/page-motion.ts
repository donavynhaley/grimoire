/**
 * Which entrance the page editor uses.
 *
 * `lift` is the product's motion: the tile that was clicked grows into the panel, so the
 * thing being edited is visibly the thing that was on the board. The other two exist to be
 * compared against it while the choice is being made, and are reachable only by asking for
 * them in the address.
 */
export type PageMotion = "lift" | "unfold" | "settle";

export const PAGE_MOTIONS: readonly PageMotion[] = ["lift", "unfold", "settle"];

export const DEFAULT_PAGE_MOTION: PageMotion = "lift";

function isPageMotion(value: string | null): value is PageMotion {
  return value !== null && (PAGE_MOTIONS as readonly string[]).includes(value);
}

/**
 * Reads the requested motion out of `?motion=`.
 *
 * Absent or unrecognised is the default, so a normal address always gets the product's
 * motion and a typo never leaves the editor without an entrance.
 */
export function resolvePageMotion(search: string): PageMotion {
  const asked = new URLSearchParams(search).get("motion");
  return isPageMotion(asked) ? asked : DEFAULT_PAGE_MOTION;
}

/** Whether the address asked about motion at all, which is what raises the comparison control. */
export function motionWasAsked(search: string): boolean {
  return new URLSearchParams(search).has("motion");
}
