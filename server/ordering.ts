/**
 * The splice-and-renumber dance behind every board move, written once.
 *
 * Positions are dense zero-based integers within a list, and every move is the same two
 * steps: clamp the newcomer into the order, then renumber the whole list and save the
 * rows whose stored position disagrees. Six hand-rolled copies of this existed, and their
 * subtle differences were not choices.
 */

/** Clamps `item` into the order at the requested position. `others` must not contain it. */
export function placeInOrder<T>(others: T[], item: T, requestedPosition: number): T[] {
  const ordered = [...others];
  ordered.splice(Math.max(0, Math.min(requestedPosition, ordered.length)), 0, item);
  return ordered;
}

/**
 * Renumbers a list to match its reading order, saving each record whose stored position
 * disagrees. `alwaysSaveId` names a record written regardless - the one whose content this
 * same operation changed. Returns the settled position of that record, or -1 without one.
 */
export function renumber<T extends { id: string; position: number }>(
  ordered: T[],
  save: (record: T) => void,
  alwaysSaveId?: string,
): number {
  let settled = -1;
  ordered.forEach((record, position) => {
    if (record.id === alwaysSaveId) settled = position;
    if (record.position !== position || record.id === alwaysSaveId) save({ ...record, position });
  });
  return settled;
}
