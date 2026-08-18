// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "../../src/components/Drawer";

afterEach(cleanup);

/**
 * Answers the media query the shell asks, since jsdom ships no `matchMedia` at all.
 *
 * That absence is itself load-bearing: with nothing to ask, the shell renders the desktop
 * dialog, which is how every existing test keeps seeing the presentation it was written for.
 */
function stubPointer(coarse: boolean) {
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse,
      media: query,
      addEventListener: (_: string, handler: () => void) => listeners.add(handler),
      removeEventListener: (_: string, handler: () => void) => listeners.delete(handler),
    }),
  });
  return () => Reflect.deleteProperty(window, "matchMedia");
}

function open(onClose = vi.fn()) {
  render(
    <Drawer className="dialog-panel page-editor" labelledBy="drawer-title" onClose={onClose}>
      <h2 id="drawer-title">Edit page</h2>
      <p>notes</p>
    </Drawer>,
  );
  return onClose;
}

describe("the drawer shell", () => {
  it("keeps the centred dialog on a desktop pointer", () => {
    const restore = stubPointer(false);
    try {
      open();
      const panel = screen.getByRole("dialog", { name: "Edit page" });
      // The classes the dialog always had, and nothing sheet-shaped added beside them.
      expect(panel).toHaveClass("dialog-panel", "page-editor");
      expect(panel).not.toHaveClass("drawer-sheet");
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("becomes a sheet with a handle on a thumb", () => {
    const restore = stubPointer(true);
    try {
      open();
      expect(screen.getByRole("dialog", { name: "Edit page" })).toHaveClass("drawer-sheet");
      expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("closes when the sheet is pulled far enough down", () => {
    const restore = stubPointer(true);
    try {
      const onClose = open();
      const handle = screen.getByRole("button", { name: "Close" });

      // A short tug is a nudge, not a dismissal, so the sheet stays.
      fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "touch", clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, pointerType: "touch", clientY: 120 });
      fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch", clientY: 120 });
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.pointerDown(handle, { pointerId: 2, pointerType: "touch", clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 2, pointerType: "touch", clientY: 400 });
      fireEvent.pointerUp(handle, { pointerId: 2, pointerType: "touch", clientY: 400 });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("closes on the handle alone, so the gesture is never the only way out", async () => {
    const restore = stubPointer(true);
    try {
      const onClose = open();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("closes on Escape in both presentations", async () => {
    for (const coarse of [false, true]) {
      const restore = stubPointer(coarse);
      try {
        const onClose = open();
        await userEvent.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        restore();
        cleanup();
      }
    }
  });

  it("sizes the sheet against the visible viewport rather than the largest one", () => {
    const restore = stubPointer(true);
    const viewport = { height: 620, offsetTop: 12, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: viewport });
    try {
      open();
      // What the keyboard and the URL bar leave behind, which is what `vh` cannot see.
      expect(document.documentElement.style.getPropertyValue("--drawer-viewport")).toBe("620px");
      expect(document.documentElement.style.getPropertyValue("--drawer-viewport-top")).toBe("12px");
    } finally {
      restore();
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("hands focus back to whatever opened it", async () => {
    const restore = stubPointer(false);
    try {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const { unmount } = render(
        <Drawer className="dialog-panel" label="Settings" onClose={vi.fn()}>
          <p>body</p>
        </Drawer>,
      );
      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    } finally {
      restore();
    }
  });
});
