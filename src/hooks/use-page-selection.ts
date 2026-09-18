import { useCallback, useRef, useState } from "react";

/** The modifier state a click carried, which is all this hook needs from the event. */
export type SelectionClick = {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export type PageSelection = {
  ids: ReadonlySet<string>;
  /**
   * Offers a click to the selection. Answers true when it was a selection, and the caller
   * must then not open the page.
   */
  select: (event: SelectionClick, id: string, order: readonly string[]) => boolean;
  clear: () => void;
  /** Drops anything no longer on the board, so a filter cannot leave work selected unseen. */
  retain: (present: ReadonlySet<string>) => void;
};

/**
 * Several cards held at once, so one decision can be made about all of them.
 *
 * A plain click still opens a page - that is what a card is for, and taking it away to make
 * room for selection would cost every reader something to give a few readers this. Selection
 * is what the modifiers mean, the way a file list has always read them: a held modifier
 * toggles one card, and shift takes everything between the last one and this.
 *
 * Shift adds its range rather than replacing the selection. Replacing is what a file list
 * does, but here the selection is assembled to be acted on rather than browsed, and silently
 * discarding cards someone has already picked out is the more expensive mistake.
 *
 * The anchor stays where the modifier put it, so two shift-clicks from one anchor describe
 * two ranges from the same place rather than walking it along.
 */
export function usePageSelection(): PageSelection {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const clear = useCallback(() => {
    anchor.current = null;
    setIds((current) => (current.size === 0 ? current : new Set()));
  }, []);

  const select = useCallback((event: SelectionClick, id: string, order: readonly string[]) => {
    const toggling = event.metaKey || event.ctrlKey;
    const extending = event.shiftKey;
    if (!toggling && !extending) return false;

    const from = anchor.current;
    if (extending && from && from !== id) {
      const start = order.indexOf(from);
      const end = order.indexOf(id);
      // A range across two columns has no run of cards between its ends, so the reach falls
      // back to the one card that was actually clicked.
      if (start !== -1 && end !== -1) {
        const [low, high] = start < end ? [start, end] : [end, start];
        const run = order.slice(low, high + 1);
        setIds((current) => new Set([...current, ...run]));
        return true;
      }
    }

    anchor.current = id;
    setIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    return true;
  }, []);

  const retain = useCallback((present: ReadonlySet<string>) => {
    setIds((current) => {
      if (current.size === 0) return current;
      const kept = [...current].filter((id) => present.has(id));
      if (kept.length === current.size) return current;
      if (anchor.current && !present.has(anchor.current)) anchor.current = null;
      return new Set(kept);
    });
  }, []);

  return { ids, select, clear, retain };
}
