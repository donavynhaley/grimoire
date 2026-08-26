import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
}

/**
 * jsdom has no layout, and the notes editor asks for some.
 *
 * CodeMirror measures text to decide what is on screen, which it does through ranges.
 * jsdom implements `Range` but not the two methods that report where a range landed, so
 * the measurement pass throws rather than returning nothing. Zero-sized rectangles are
 * the honest answer in a document that was never laid out: the editor concludes it can
 * see everything, which is exactly what a test wants to assert against.
 */
if (typeof Range !== "undefined") {
  const empty = (): DOMRect => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });

  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = empty;
  }
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects(): DOMRectList {
      const list: DOMRect[] = [];
      return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList;
    };
  }
}
