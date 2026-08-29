import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCoarsePointer } from "../hooks/use-coarse-pointer";
import { useDialogEscape } from "../hooks/use-dialog-escape";

/** Dragged this far down, the sheet is being dismissed rather than nudged. */
const DISMISS_DISTANCE = 96;
/** Or thrown at least this far, this fast, which is a flick rather than a drag. */
const FLICK_DISTANCE = 32;
const DISMISS_VELOCITY = 0.55;

type Props = {
  /**
   * Classes for the panel itself. On a desktop pointer these are the only thing that styles
   * it, which is how the centred dialog stays exactly as it was.
   */
  className: string;
  /** Extra classes for the backdrop, for the two surfaces that inset theirs differently. */
  backdropClassName?: string;
  /** The heading that names this drawer. */
  labelledBy?: string;
  /** Used instead when the drawer has no heading element to point at. */
  label?: string;
  /**
   * Leaving. May refuse - an editor with an unsaved change that will not flush keeps its
   * drawer open - in which case a swipe springs back rather than closing.
   */
  onClose: () => void | Promise<void>;
  children: ReactNode;
};

/**
 * The one overlay shell: a centred dialog on a desktop pointer, a full sheet on a thumb.
 *
 * Nine surfaces used to each render their own backdrop and panel, and each got patched into
 * something sheet-shaped below 620px by its own handful of overrides. They were sized in `vh`,
 * so on iOS the footer sat behind the URL bar; they had no safe-area padding, so they ran under
 * the home indicator; and the only way out of one was a close button the size of a full stop.
 *
 * Desktop is deliberately untouched. On a fine pointer this renders the same backdrop and the
 * same panel classes the dialogs always had, so the centred presentation is not a variant of
 * the sheet - it is the original, still in place. Everything the sheet needs and the dialog
 * does not is added only when a thumb is holding the device.
 */
export function Drawer({ className, backdropClassName = "", labelledBy, label, onClose, children }: Props) {
  const coarse = useCoarsePointer();
  const panel = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<{ from: number; at: number; startedAt: number } | null>(null);
  const offset = drag ? Math.max(0, drag.at - drag.from) : 0;

  useDialogEscape(onClose);
  useViewportSizing(coarse);
  useFocusReturn();
  useFocusContainment(panel);

  /**
   * The sheet follows the finger, and lets go if it was carried far enough or thrown hard
   * enough. Anything short of that springs back, which is also what happens when the drawer
   * refuses to close.
   */
  const swipe = {
    onPointerDown: (event: React.PointerEvent) => {
      if (!coarse || event.pointerType === "mouse") return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDrag({ from: event.clientY, at: event.clientY, startedAt: performance.now() });
    },
    onPointerMove: (event: React.PointerEvent) => {
      setDrag((current) => (current ? { ...current, at: event.clientY } : current));
    },
    onPointerUp: (event: React.PointerEvent) => {
      setDrag((current) => {
        if (!current) return null;
        const travelled = event.clientY - current.from;
        const elapsed = Math.max(1, performance.now() - current.startedAt);
        // Velocity alone cannot dismiss: over a millisecond or two, the smallest twitch
        // divides out to an enormous speed, and a nudge would throw the sheet away.
        const flicked = travelled > FLICK_DISTANCE && travelled / elapsed > DISMISS_VELOCITY;
        if (travelled > DISMISS_DISTANCE || flicked) void onClose();
        return null;
      });
    },
    onPointerCancel: () => setDrag(null),
  };

  if (!coarse) {
    return (
      <div
        className={`modal-backdrop ${backdropClassName}`.trim()}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) void onClose();
        }}
      >
        <section
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-modal="true"
          className={className}
          ref={panel}
          role="dialog"
          tabIndex={-1}
        >
          {children}
        </section>
      </div>
    );
  }

  return (
    <div
      className={`modal-backdrop drawer-backdrop ${backdropClassName}`.trim()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) void onClose();
      }}
    >
      <section
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={`${className} drawer-sheet`}
        ref={panel}
        role="dialog"
        style={offset ? { transform: `translateY(${offset}px)`, transition: "none" } : undefined}
        tabIndex={-1}
      >
        {/*
          The handle is both the affordance and the target: it says the sheet can be pulled
          down, and it is the part that hears the pull. Dragging from the body instead would
          fight the list scrolling inside it.
        */}
        <button
          aria-label="Close"
          className="drawer-grabber"
          onClick={() => void onClose()}
          type="button"
          {...swipe}
        >
          <span aria-hidden="true" />
        </button>
        {children}
      </section>
    </div>
  );
}

/**
 * Sizes the sheet against the viewport that is actually visible.
 *
 * `vh` on iOS means the largest the viewport ever gets, so a sheet measured in it puts its
 * own footer behind the URL bar. The visual viewport is the part not covered by browser
 * furniture or the keyboard, which is the only measurement a bottom sheet can trust: when the
 * keyboard opens over a notes field, this is what moves the sheet above it.
 */
function useViewportSizing(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty("--drawer-viewport", `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty("--drawer-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      root.style.removeProperty("--drawer-viewport");
      root.style.removeProperty("--drawer-viewport-top");
    };
  }, [active]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Puts focus in the dialog when it opens, and holds Tab inside it while it is open.
 *
 * aria-modal promises assistive tech the rest of the page is inert; this keeps the
 * promise for the keyboard too, or Tab walks out the back of the dialog into a page
 * that cannot be clicked. A field that focused itself on mount keeps its claim.
 */
function useFocusContainment(panel: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const hold = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusables = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", hold, true);
    return () => document.removeEventListener("keydown", hold, true);
  }, [panel]);
}

/**
 * Hands focus back to whatever opened the drawer once it closes.
 *
 * Without this, closing a drawer drops focus at the top of the document, which on a keyboard
 * means starting the walk to where you already were all over again.
 */
function useFocusReturn(): void {
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
}
