import { useEffect, useState } from "react";
import { type DragPoint, usePointerDrag } from "./use-pointer-drag";

/** The gap a gesture is pointing at: which slot of the board, and which position within it. */
export type CardHint<TSlot extends string> = { slot: TSlot; index: number };

type Options<TSlot extends string, TItem extends { id: string; title: string }> = {
  items: readonly TItem[];
  /** The card currently open, so its away-dot can be marked answered for the visit. */
  selectedId: string | null;
  /** Which gap a point is over; the caller reads its own board's geometry. */
  hintAt: (point: DragPoint) => CardHint<TSlot> | null;
  /** The gap a card occupies at the moment it lifts, seeding the drop hint. */
  liftHint: (item: TItem) => CardHint<TSlot> | null;
  /** Writes the placement a finished gesture chose. */
  place: (id: string, hint: CardHint<TSlot>) => Promise<void>;
};

export type CardBoard<TSlot extends string, TItem extends { id: string; title: string }> = {
  drag: { id: string; height: number } | null;
  dropHint: CardHint<TSlot> | null;
  /** The id of the card held by tap or key, or null. */
  moving: string | null;
  movingItem: TItem | null;
  /** Whichever card has left the flow of its list, carried or held. */
  liftedId: string | null;
  liftedItem: TItem | null;
  /** Cards the reader has opened this visit; their dots have been answered. */
  openedUnseen: ReadonlySet<string>;
  pointerDrag: ReturnType<typeof usePointerDrag>;
  /** Puts a card down where a tap asked for it, and leaves the moving state either way. */
  placeMoving: (slot: TSlot, index: number) => Promise<void>;
  toggleMoving: (id: string) => void;
  cancelMoving: () => void;
};

/**
 * The two ways a card leaves its place on a board: carried by a pointer, or held by tap or key.
 *
 * Dragging is a gesture some people cannot make and some devices cannot report. Holding a
 * card in the moving state turns every gap on the board into an ordinary button, which is the
 * same move performed with one tap, or with Tab and Enter, and it is the only way a keyboard
 * has ever been able to reorder these boards at all. The work board and the idea garden share
 * this machinery whole; only their geometry and their writes differ, and those come in as
 * accessors.
 */
export function useCardBoard<TSlot extends string, TItem extends { id: string; title: string }>({
  items,
  selectedId,
  hintAt,
  liftHint,
  place,
}: Options<TSlot, TItem>): CardBoard<TSlot, TItem> {
  const [drag, setDrag] = useState<{ id: string; height: number } | null>(null);
  const [dropHint, setDropHint] = useState<CardHint<TSlot> | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [openedUnseen, setOpenedUnseen] = useState<ReadonlySet<string>>(() => new Set());

  // Opening a card answers its dot, whichever surface it was opened from.
  useEffect(() => {
    if (!selectedId) return;
    setOpenedUnseen((current) => {
      if (current.has(selectedId)) return current;
      const next = new Set(current);
      next.add(selectedId);
      return next;
    });
  }, [selectedId]);

  // A card put down by tap is put down by Escape too, the same key that calls off a drag.
  useEffect(() => {
    if (!moving) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMoving(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [moving]);

  const finishDrag = () => {
    setDrag(null);
    setDropHint(null);
  };

  const pointerDrag = usePointerDrag({
    onLift: (id, height) => {
      const item = items.find((candidate) => candidate.id === id);
      setDrag({ id, height });
      setDropHint(item ? liftHint(item) : null);
      // A card cannot be carried and tapped into place at the same time.
      setMoving(null);
    },
    onMove: (point) => {
      const hint = hintAt(point);
      setDropHint((current) => (sameHint(current, hint) ? current : hint));
    },
    onDrop: async (point) => {
      const id = drag?.id;
      const hint = hintAt(point) ?? dropHint;
      finishDrag();
      if (!id || !hint) return;
      await place(id, hint);
    },
    onCancel: finishDrag,
  });

  const placeMoving = async (slot: TSlot, index: number) => {
    const id = moving;
    setMoving(null);
    if (!id) return;
    await place(id, { slot, index });
  };

  const liftedId = drag?.id ?? moving;
  const movingItem = moving ? (items.find((item) => item.id === moving) ?? null) : null;
  const liftedItem = pointerDrag.lift
    ? (items.find((item) => item.id === pointerDrag.lift?.id) ?? null)
    : null;

  return {
    drag,
    dropHint,
    moving,
    movingItem,
    liftedId,
    liftedItem,
    openedUnseen,
    pointerDrag,
    placeMoving,
    toggleMoving: (id) => setMoving((current) => (current === id ? null : id)),
    cancelMoving: () => setMoving(null),
  };
}

function sameHint<TSlot extends string>(
  left: CardHint<TSlot> | null,
  right: CardHint<TSlot> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.slot === right.slot && left.index === right.index;
}
