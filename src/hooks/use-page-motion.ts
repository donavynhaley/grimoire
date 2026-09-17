import { type RefObject, useLayoutEffect, useRef } from "react";
import type { PageMotion } from "../lib/page-motion";

/** The panel travels further than anything else on screen, so it gets longer than a dialog fade. */
const OPEN_DURATION = 260;
/** The curve every other motion in the product uses, so this one is not a new opinion. */
const OPEN_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";
/** Leaving is quicker than arriving: the answer is already known, and the board is wanted back. */
const CLOSE_DURATION = 190;
const CLOSE_EASING = "cubic-bezier(0.45, 0, 0.9, 0.45)";
/**
 * How small the panel starts.
 *
 * The clip is what makes the tile-sized opening; the scale is what makes it read as growth
 * rather than as a window sliding across a fixed panel. It stays mild because the chrome is
 * all that is visible while it runs - the writing is still faded out at this size.
 */
const START_SCALE = 0.9;

/** The CSS exits, by name, so an indicator looping inside the panel is never waited on. */
const CSS_EXITS = new Set([
  "page-modal-fade-out",
  "page-modal-leave",
  "page-veil-out",
  "page-unfold-out",
  "drawer-fall",
]);

type Options = {
  motion: PageMotion;
  /** The `data-flip-id` of the tile this page was opened from, when it is still on the board. */
  originId: string;
  closing: boolean;
  onExited: () => void;
};

/**
 * The page editor arriving from, and returning to, the tile it belongs to.
 *
 * A dialog that fades in over the middle of the board says a panel appeared; it does not say
 * which page it is about, and the eye has to find that out by reading the title. Growing the
 * panel out of the tile that was clicked answers it before any reading happens, and answers
 * the same question on the way out by putting the page back where it now lives - which, after
 * a column change made while it was open, is not where it was picked up.
 *
 * Nothing scales except the panel's own surface. The opening is a clip window sized to the
 * tile and carried on a translate, so the writing inside is at its final size from the first
 * frame it can be seen at, and no text is ever stretched to arrive.
 *
 * Only the centred dialog lifts. On a thumb the panel is the whole screen, there is no tile
 * left visible to grow from, and the sheet's own rise is already the right gesture - so the
 * stylesheet keeps that one and this stays out of its way.
 */
export function usePageMotion(shell: RefObject<HTMLElement | null>, options: Options): void {
  const { motion, originId, closing, onExited } = options;
  const entrance = useRef<Animation[]>([]);
  const exited = useRef(onExited);
  useLayoutEffect(() => {
    exited.current = onExited;
  }, [onExited]);

  useLayoutEffect(() => {
    const root = shell.current;
    if (!root || motion !== "lift") return;
    const panel = liftablePanel(root);
    if (!panel) return;
    const opening = measure(panel, originId);
    if (!opening) {
      // Nowhere to grow from. The stylesheet's plain entrance is a better answer than a panel
      // that appears with no entrance at all, and the exit that matches it comes with it.
      root.dataset.plain = "";
      return () => {
        delete root.dataset.plain;
      };
    }
    entrance.current = play(panel, opening, "in");

    // The writing crosses over in the stylesheet rather than here, because the editor itself
    // is still being downloaded when the panel starts growing and arrives as a child that did
    // not exist to be animated. An attribute the rule hangs off covers whatever is inside the
    // panel at any point during the entrance, including the body that turns up halfway.
    //
    // These are attributes rather than classes because the shell's `className` is React's, and
    // it is rewritten in full on every render - the editor finishing its download is one - so a
    // class added here would be wiped partway through the very entrance it is describing.
    root.dataset.entering = "";
    const settle = () => {
      delete root.dataset.entering;
    };
    entrance.current[0]?.addEventListener("finish", settle);

    return () => {
      settle();
      for (const animation of entrance.current) animation.cancel();
      entrance.current = [];
    };
  }, [shell, motion, originId]);

  useLayoutEffect(() => {
    if (!closing) return;
    const root = shell.current;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) exited.current();
    };

    // Measuring has to happen from the resting geometry, so an entrance still in flight hands
    // the panel back to the stylesheet before the exit reads where it is returning to.
    for (const animation of entrance.current) animation.cancel();
    entrance.current = [];

    const panel = root && motion === "lift" ? liftablePanel(root) : null;
    const leaving = panel ? measure(panel, originId) : null;
    const exits = leaving && panel ? play(panel, leaving, "out") : cssExits(root);

    if (exits.length) void Promise.allSettled(exits.map((animation) => animation.finished)).then(finish);
    else finish();
    return () => {
      cancelled = true;
    };
  }, [shell, motion, originId, closing]);
}

/** The centred panel, or nothing when the surface is a full-height sheet or motion is refused. */
function liftablePanel(root: HTMLElement): HTMLElement | null {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const panel = root.querySelector<HTMLElement>(".page-editor");
  if (!panel || panel.classList.contains("drawer-sheet")) return null;
  return typeof panel.animate === "function" ? panel : null;
}

type Opening = {
  /** Where the panel sits when its clip window is over the tile. */
  translate: string;
  /** The tile-sized window, in the panel's own coordinates, before the start scale is applied. */
  clip: string;
  /** The panel's resting corner, which the window grows into. */
  rested: string;
  backdrop: HTMLElement | null;
  /** The backdrop at rest: what the veil and the blur behind it arrive at. */
  veil: { backgroundColor: string; backdropFilter?: string };
};

/**
 * Works out the opening the panel grows from.
 *
 * The clip window is in the panel's untransformed coordinates while the start scale is what
 * finally sizes it on screen, so the window is divided by that scale to land on the tile. A
 * tile wider than the scaled panel would ask for a negative inset, which is clamped rather
 * than refused: the opening is then simply the whole panel.
 */
function measure(panel: HTMLElement, originId: string): Opening | null {
  const tile = document.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(originId)}"]`);
  // A page reached from search, or one whose tile is filtered off the board, has nothing to
  // grow out of. The stylesheet's plain entrance is the honest answer there.
  if (!tile) return null;
  const from = tile.getBoundingClientRect();
  if (from.width < 1 || from.height < 1) return null;
  const to = panel.getBoundingClientRect();
  if (to.width < 1 || to.height < 1) return null;

  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const inset = (panelSide: number, tileSide: number) =>
    Math.max(0, (panelSide - tileSide / START_SCALE) / 2);
  const radius = pixels(getComputedStyle(tile).borderTopLeftRadius) / START_SCALE;
  const backdrop = panel.closest<HTMLElement>(".modal-backdrop");

  return {
    translate: `${dx}px ${dy}px`,
    clip: `inset(${inset(to.height, from.height)}px ${inset(to.width, from.width)}px round ${radius}px)`,
    rested: `inset(0 round ${pixels(getComputedStyle(panel).borderTopLeftRadius)}px)`,
    backdrop,
    veil: backdrop ? veilOf(backdrop) : { backgroundColor: "transparent" },
  };
}

/**
 * What the backdrop looks like once it has arrived, read rather than written.
 *
 * The veil is its background and the blur behind it - never its `opacity`, which would take
 * the panel down with it: the panel is the backdrop's own child, so fading the element fades
 * everything standing on it, and the board shows straight through the surface that is supposed
 * to be covering it. Animating the colour leaves the panel opaque from the first frame.
 */
function veilOf(backdrop: HTMLElement): Opening["veil"] {
  const style = getComputedStyle(backdrop);
  const blur = style.backdropFilter;
  return {
    backgroundColor: style.backgroundColor,
    // Only a blur is worth ramping, and only when there is one; `none` has nothing to grow from.
    ...(blur.startsWith("blur(") ? { backdropFilter: blur } : {}),
  };
}

/**
 * Runs the panel and its backdrop as one gesture.
 *
 * The writing inside is not here: it crosses over from the stylesheet, on a delay, so that it
 * is never read at the size the opening starts at. What the eye gets is writing appearing in
 * a panel rather than writing unfolding with it.
 */
function play(panel: HTMLElement, opening: Opening, direction: "in" | "out"): Animation[] {
  const entering = direction === "in";
  const shut = { translate: opening.translate, scale: String(START_SCALE), clipPath: opening.clip };
  const open = { translate: "0px 0px", scale: "1", clipPath: opening.rested };
  const duration = entering ? OPEN_DURATION : CLOSE_DURATION;
  const running = [
    panel.animate(entering ? [shut, open] : [open, shut], {
      duration,
      easing: entering ? OPEN_EASING : CLOSE_EASING,
      // Only the exit holds: its last frame is the tile, which is not where the panel rests.
      // The entrance ends exactly where the stylesheet already puts it, so it hands back.
      fill: entering ? "none" : "forwards",
    }),
  ];

  if (opening.backdrop && typeof opening.backdrop.animate === "function") {
    const clear = {
      backgroundColor: "transparent",
      ...(opening.veil.backdropFilter ? { backdropFilter: "blur(0px)" } : {}),
    };
    const veiled = { ...opening.veil };
    running.push(
      opening.backdrop.animate(entering ? [clear, veiled] : [veiled, clear], {
        duration,
        easing: entering ? "ease-out" : "ease-in",
        fill: entering ? "none" : "forwards",
      }),
    );
  }

  return running;
}

/** The stylesheet's own exits, for the sheet, the other motions, and reduced motion's absence of one. */
function cssExits(root: HTMLElement | null): Animation[] {
  return (
    root
      ?.getAnimations?.({ subtree: true })
      .filter((animation) => animation instanceof CSSAnimation && CSS_EXITS.has(animation.animationName)) ??
    []
  );
}

function pixels(value: string): number {
  const measured = Number.parseFloat(value);
  return Number.isFinite(measured) ? measured : 0;
}
