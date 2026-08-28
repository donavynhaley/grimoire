// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePointerDrag } from "../../src/components/use-pointer-drag";

afterEach(cleanup);

type Recorded = {
  lifts: string[];
  moves: Array<{ x: number; y: number }>;
  drops: Array<{ x: number; y: number }>;
  cancels: number;
};

function Harness({ log }: { log: Recorded }) {
  const drag = usePointerDrag({
    onLift: (id) => {
      log.lifts.push(id);
    },
    onMove: (point) => {
      log.moves.push(point);
    },
    onDrop: (point) => {
      log.drops.push(point);
    },
    onCancel: () => {
      log.cancels += 1;
    },
  });
  return (
    <article data-testid="card" onPointerDown={(event) => drag.start(event, "page-1")}>
      <button
        onClick={() => {
          if (!drag.consumeClick()) log.lifts.push("opened");
        }}
        type="button"
      >
        open
      </button>
      <span data-testid="state">{drag.dragging ? "lifted" : "resting"}</span>
    </article>
  );
}

function mount() {
  const log: Recorded = { lifts: [], moves: [], drops: [], cancels: 0 };
  render(<Harness log={log} />);
  return { log, card: screen.getByTestId("card"), state: () => screen.getByTestId("state").textContent };
}

describe("carrying a card with a pointer", () => {
  it("lifts a mouse the moment it travels", () => {
    const { log, card, state } = mount();
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    expect(state()).toBe("resting");

    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 40 });
    expect(state()).toBe("lifted");
    expect(log.lifts).toEqual(["page-1"]);

    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 40 });
    expect(log.drops).toEqual([{ x: 10, y: 40 }]);
    expect(state()).toBe("resting");
  });

  it("leaves a finger alone until it has held still", () => {
    vi.useFakeTimers();
    try {
      const { log, card, state } = mount();

      // A touch that sets off straight away was scrolling the board.
      fireEvent.pointerDown(card, {
        pointerId: 2,
        pointerType: "touch",
        button: 0,
        clientX: 10,
        clientY: 300,
      });
      fireEvent.pointerMove(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 260 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(state()).toBe("resting");
      expect(log.lifts).toEqual([]);
      fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 260 });
      expect(log.drops).toEqual([]);

      // Holding still lifts it.
      fireEvent.pointerDown(card, {
        pointerId: 3,
        pointerType: "touch",
        button: 0,
        clientX: 10,
        clientY: 300,
      });
      expect(state()).toBe("resting");
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(state()).toBe("lifted");
      expect(log.lifts).toEqual(["page-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up the card when the touch is cancelled", () => {
    const { log, card, state } = mount();
    fireEvent.pointerDown(card, { pointerId: 4, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 4, pointerType: "mouse", clientX: 10, clientY: 60 });
    expect(state()).toBe("lifted");

    fireEvent.pointerCancel(window, { pointerId: 4, pointerType: "mouse" });
    expect(state()).toBe("resting");
    expect(log.cancels).toBe(1);
    expect(log.drops).toEqual([]);
  });

  it("puts the card down on Escape without moving it", () => {
    const { log, card, state } = mount();
    fireEvent.pointerDown(card, { pointerId: 5, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 5, pointerType: "mouse", clientX: 10, clientY: 60 });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(state()).toBe("resting");
    expect(log.cancels).toBe(1);
    expect(log.drops).toEqual([]);
  });

  it("swallows the click that chases a drag, and only that one", () => {
    const { log, card } = mount();
    const open = screen.getByRole("button", { name: "open" });

    // Releasing over the card it started on is still a click; it must not also open the page.
    fireEvent.pointerDown(card, { pointerId: 6, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 6, pointerType: "mouse", clientX: 10, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 6, pointerType: "mouse", clientX: 10, clientY: 60 });
    fireEvent.click(open);
    expect(log.lifts).toEqual(["page-1"]);

    // The next honest click still lands, with no timer having had to expire first.
    fireEvent.pointerDown(card, { pointerId: 7, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 7, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.click(open);
    expect(log.lifts).toEqual(["page-1", "opened"]);
  });

  it("ignores a secondary button, which is a context menu rather than a drag", () => {
    const { state, card } = mount();
    fireEvent.pointerDown(card, { pointerId: 8, pointerType: "mouse", button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 8, pointerType: "mouse", clientX: 10, clientY: 60 });
    expect(state()).toBe("resting");
  });
});
