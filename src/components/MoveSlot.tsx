/**
 * One place a held card can be put down.
 *
 * These are ordinary buttons, which is the whole point: the gap a mouse finds by hovering
 * over it is the same gap a finger finds by tapping it and a keyboard finds by tabbing to it.
 * A ranked list's slots name a position; an unranked one's name only the section.
 */
export function MoveSlot<TSlot extends string>({
  index,
  onPlace,
  ranked = true,
  slot,
  slotName,
  title,
}: {
  index: number;
  onPlace: (slot: TSlot, index: number) => Promise<void>;
  ranked?: boolean;
  slot: TSlot;
  slotName: string;
  title: string;
}) {
  return (
    <button
      aria-label={
        ranked ? `Place ${title} in ${slotName}, position ${index + 1}` : `Move ${title} to ${slotName}`
      }
      className="move-slot"
      onClick={() => void onPlace(slot, index)}
      type="button"
    >
      <span aria-hidden="true">place here</span>
    </button>
  );
}
