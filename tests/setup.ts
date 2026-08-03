import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
}
