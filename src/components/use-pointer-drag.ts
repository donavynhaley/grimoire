import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** A finger has to rest this long before a card lifts, so a pan down the board still scrolls. */
const HOLD_MS = 250;
/** A mouse lifts as soon as it means it, which is the moment it travels at all. */
const MOVE_THRESHOLD = 4;
/** Travelling further than this before the hold completes was a scroll, not a lift. */
const HOLD_SLOP = 10;
/** How close to the edge of the window the pointer has to come before the page follows it. */
const EDGE_BAND = 76;
const EDGE_SPEED = 22;

export type DragPoint = { x: number; y: number };

/**
 * A card that has left the page and is now following the pointer.
 *
 * The rectangle is where it sat at the moment it lifted, so the ghost can be placed exactly
 * over the card it replaces; the delta is how far the pointer has travelled since.
 */
export type Lift = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
};

type Options = {
  /** Where the pointer now is, so the board can work out which gap it is pointing at. */
  onMove: (point: DragPoint) => void;
  /** The gesture finished over this point. */
  onDrop: (point: DragPoint) => void | Promise<void>;
  /** The gesture was abandoned: Escape, a cancelled touch, a window that lost the pointer. */
  onCancel: () => void;
  /** The card actually lifted, which is later than the pointer going down. */
  onLift?: (id: string, height: number) => void;
};

type Pending = {
  id: string;
  pointerId: number;
  coarse: boolean;
  originX: number;
  originY: number;
  rect: { left: number; top: number; width: number; height: number };
  node: HTMLElement;
  timer: number | null;
  lifted: boolean;
};

/**
 * One drag gesture, driven by pointer events rather than HTML5 drag-and-drop.
 *
 * The board used to move on `dragstart`/`dragover`/`drop`, which no mobile browser has ever
 * fired from a touch screen: every rearrangement was mouse-only. Pointer events are the one
 * input model every device speaks, so this hook replaces that machinery for mouse, pen, and
 * finger at once, rather than adding a second path beside it.
 *
 * The two pointers ask for opposite things and get them. A mouse lifts a card the instant it
 * moves, because a mouse that is moving over a card it pressed means to drag it. A finger has
 * to rest first, because the same gesture on a phone is how the board is scrolled, and a card
 * that lifted on contact would make the page impossible to read. Moving during the rest
 * abandons the lift and leaves the scroll it turned out to be.
 *
 * Everything above this hook - the drop hint, the placeholder, the FLIP glide - is unchanged
 * and still driven by a viewport `y`, so the desktop drag it used to serve feels exactly as
 * it did.
 */
export function usePointerDrag({ onMove, onDrop, onCancel, onLift }: Options) {
  const [lift, setLift] = useState<Lift | null>(null);
  const pending = useRef<Pending | null>(null);
  const latest = useRef<DragPoint>({ x: 0, y: 0 });
  const scrolling = useRef<number | null>(null);
  /**
   * Whether the gesture that just ended was a drag, so the click chasing it can be ignored.
   *
   * A pointer going down always clears this before any genuine click can follow, which is why
   * it needs no timer to expire: there is no moment at which a stale `true` could be read.
   */
  const dragged = useRef(false);
  // Handlers are read through a ref so the window listeners below are bound once and never
  // resubscribe mid-gesture when the board re-renders under the pointer.
  const handlers = useRef({ onMove, onDrop, onCancel, onLift });
  handlers.current = { onMove, onDrop, onCancel, onLift };

  const stopScrolling = useCallback(() => {
    if (scrolling.current === null) return;
    cancelAnimationFrame(scrolling.current);
    scrolling.current = null;
  }, []);

  /** Releases the gesture without deciding what it meant; both endings run through here. */
  const teardown = useCallback(() => {
    const current = pending.current;
    if (current?.timer !== null && current?.timer !== undefined) window.clearTimeout(current.timer);
    if (current?.lifted) {
      try {
        current.node.releasePointerCapture?.(current.pointerId);
      } catch {
        // The capture is already gone whenever the pointer itself is, which is fine.
      }
    }
    pending.current = null;
    stopScrolling();
    document.documentElement.classList.remove("dragging-card");
    setLift(null);
  }, [stopScrolling]);

  /**
   * Follows the pointer when it reaches the top or bottom of the window.
   *
   * The mobile board is one tall page, so a card being carried to a column further down has
   * to be able to reach it without a second hand. Speed rises as the pointer nears the edge,
   * so a small correction near the boundary does not throw the page.
   */
  const edgeScroll = useCallback(() => {
    scrolling.current = null;
    if (!pending.current?.lifted) return;
    const { y } = latest.current;
    const height = window.innerHeight;
    let delta = 0;
    if (y < EDGE_BAND) delta = -EDGE_SPEED * (1 - y / EDGE_BAND);
    else if (y > height - EDGE_BAND) delta = EDGE_SPEED * (1 - (height - y) / EDGE_BAND);
    if (delta !== 0) {
      const scroller = scrollableUnder(latest.current);
      if (scroller) scroller.scrollTop += delta;
      else window.scrollBy?.(0, delta);
      // The board moved under a stationary pointer, so the hint has to be asked again.
      handlers.current.onMove(latest.current);
    }
    scrolling.current = requestAnimationFrame(edgeScroll);
  }, []);

  const beginLift = useCallback(() => {
    const current = pending.current;
    if (!current || current.lifted) return;
    current.lifted = true;
    current.timer = null;
    try {
      current.node.setPointerCapture?.(current.pointerId);
    } catch {
      // Capture is a convenience; the window listeners below carry the gesture without it.
    }
    // Suppresses the browser's own scrolling and text selection for as long as the card is up.
    document.documentElement.classList.add("dragging-card");
    setLift({
      id: current.id,
      left: current.rect.left,
      top: current.rect.top,
      width: current.rect.width,
      height: current.rect.height,
      dx: latest.current.x - current.originX,
      dy: latest.current.y - current.originY,
    });
    handlers.current.onLift?.(current.id, current.rect.height);
    handlers.current.onMove(latest.current);
    if (scrolling.current === null) scrolling.current = requestAnimationFrame(edgeScroll);
  }, [edgeScroll]);

  const start = useCallback((event: ReactPointerEvent<HTMLElement>, id: string) => {
    // A secondary mouse button is a context menu, and a second finger during a drag is not
    // a second drag.
    if (event.button !== 0 || pending.current) return;
    dragged.current = false;
    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();
    const coarse = event.pointerType !== "mouse";
    latest.current = { x: event.clientX, y: event.clientY };
    pending.current = {
      id,
      pointerId: event.pointerId,
      coarse,
      originX: event.clientX,
      originY: event.clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      node,
      timer: null,
      lifted: false,
    };
    if (coarse) pending.current.timer = window.setTimeout(beginLift, HOLD_MS);
  }, [beginLift]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = pending.current;
      if (!current || event.pointerId !== current.pointerId) return;
      latest.current = { x: event.clientX, y: event.clientY };
      const travelled = Math.hypot(event.clientX - current.originX, event.clientY - current.originY);

      if (!current.lifted) {
        // A finger that wandered during the hold was scrolling the board, and a mouse that
        // moved at all meant to drag.
        if (current.coarse) {
          if (travelled > HOLD_SLOP) teardown();
        } else if (travelled > MOVE_THRESHOLD) {
          beginLift();
        }
        return;
      }

      // Once a card is up it owns the gesture, including the scroll the browser would do.
      if (event.cancelable) event.preventDefault();
      setLift((value) => (value ? { ...value, dx: event.clientX - current.originX, dy: event.clientY - current.originY } : value));
      handlers.current.onMove(latest.current);
    };

    const up = (event: PointerEvent) => {
      const current = pending.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const wasLifted = current.lifted;
      const point = { x: event.clientX, y: event.clientY };
      teardown();
      if (!wasLifted) return;
      // Releasing a card over the one it started on is still a click as far as the browser
      // is concerned, and that click would open the page the reader was only rearranging.
      dragged.current = true;
      void handlers.current.onDrop(point);
    };

    const abandon = (event: PointerEvent) => {
      const current = pending.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const wasLifted = current.lifted;
      teardown();
      if (wasLifted) handlers.current.onCancel();
    };

    const abandonOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pending.current?.lifted) return;
      // A drag being called off answers the key before any dialog underneath it does.
      event.preventDefault();
      event.stopPropagation();
      teardown();
      handlers.current.onCancel();
    };

    // Non-passive, because a lifted card has to be able to refuse the browser's scroll.
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("keydown", abandonOnEscape, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("keydown", abandonOnEscape, true);
      teardown();
    };
  }, [beginLift, teardown]);

  /**
   * Answers whether the click now being handled is the tail of a drag, and forgets it either way.
   *
   * Every control on a card asks this before acting, so carrying a page and putting it back
   * where it started never also opens it.
   */
  const consumeClick = useCallback(() => {
    if (!dragged.current) return false;
    dragged.current = false;
    return true;
  }, []);

  return { lift, start, consumeClick, dragging: lift !== null };
}

/**
 * Which gap in a list of cards a height falls into.
 *
 * The card being carried is excluded by the caller's selector, so the gaps counted are the
 * ones that will actually exist once it lands.
 */
export function gapIndexIn(container: HTMLElement, selector: string, y: number): number {
  const cards = container.querySelectorAll<HTMLElement>(selector);
  for (let position = 0; position < cards.length; position += 1) {
    const rect = cards[position].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return position;
  }
  return cards.length;
}

/** Whether a point falls inside an element's box. */
export function pointWithin(rect: DOMRect, point: DragPoint): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

/** The nearest element under the pointer that can actually scroll, or null for the page itself. */
function scrollableUnder(point: DragPoint): HTMLElement | null {
  let node = document.elementFromPoint(point.x, point.y);
  while (node instanceof HTMLElement) {
    const style = getComputedStyle(node);
    const scrolls = /(auto|scroll)/.test(`${style.overflowY}`);
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}
