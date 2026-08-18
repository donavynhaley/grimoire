// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTypingFocus } from "../../src/components/use-typing-focus";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
});

function stubPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse, media: query, addEventListener() {}, removeEventListener() {} }),
  });
}

function Field({ always }: { always?: boolean }) {
  const focus = useTypingFocus<HTMLInputElement>(always === undefined ? {} : { always });
  return <input aria-label="field" ref={focus} />;
}

describe("focusing a field on arrival", () => {
  it("takes the caret on a desktop pointer", () => {
    stubPointer(false);
    render(<Field />);
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
  });

  it("leaves the keyboard down on a phone, where it would cover what was opened", () => {
    stubPointer(true);
    render(<Field />);
    expect(document.activeElement).not.toBe(screen.getByLabelText("field"));
  });

  it("still claims a surface whose only purpose is typing", () => {
    stubPointer(true);
    render(<Field always />);
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
  });

  it("does not steal focus back on a later render", () => {
    stubPointer(false);
    const { rerender } = render(<Field />);
    const field = screen.getByLabelText("field");
    expect(document.activeElement).toBe(field);

    field.blur();
    rerender(<Field />);
    expect(document.activeElement).not.toBe(field);
  });
});
