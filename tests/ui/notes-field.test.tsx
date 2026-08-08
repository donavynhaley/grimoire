// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesField } from "../../src/components/NotesField";
import { plainTextFromMarkdown } from "../../src/components/markdown-text";

afterEach(cleanup);

function renderNotes(value: string, onChange: (value: string) => void = () => undefined) {
  return render(
    <NotesField
      editLabel="Edit notes"
      label="Notes"
      name="description"
      onChange={onChange}
      placeholder="Add only the context someone needs to act..."
      rows={6}
      textareaLabel="Notes"
      value={value}
    />,
  );
}

describe("NotesField", () => {
  it("renders notes as formatted Markdown instead of raw syntax", () => {
    renderNotes("# Goal\n\nUse **bold** words and a [reference](https://example.com).\n\n- first\n- second");

    expect(screen.getByRole("heading", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();

    const link = screen.getByRole("link", { name: "reference" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("shows raw HTML as text rather than injecting it", () => {
    renderNotes('<img src="x" onerror="alert(1)">definitely text');

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/definitely text/)).toBeInTheDocument();
  });

  it("opens the editor when the rendered notes are clicked and returns on blur", async () => {
    renderNotes("Some **notes** here");

    await userEvent.click(screen.getByText("notes"));
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("Some **notes** here");

    await userEvent.tab();
    expect(screen.queryByRole("textbox", { name: "Notes" })).not.toBeInTheDocument();
    expect(screen.getByText("notes").tagName).toBe("STRONG");
  });

  it("keeps link clicks from entering edit mode", async () => {
    renderNotes("See the [design doc](https://example.com).");

    await userEvent.click(screen.getByRole("link", { name: "design doc" }));
    expect(screen.queryByRole("textbox", { name: "Notes" })).not.toBeInTheDocument();
  });

  it("offers the placeholder and an edit button when notes are empty", async () => {
    const onChange = vi.fn();
    renderNotes("", onChange);

    expect(screen.getByText("Add only the context someone needs to act...")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes" }), "a");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("closes the editor on Escape without losing the draft owner", async () => {
    renderNotes("draft text");

    await userEvent.click(screen.getByText("draft text"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Notes" })).not.toBeInTheDocument();
    expect(screen.getByText("draft text")).toBeInTheDocument();
  });
});

describe("plainTextFromMarkdown", () => {
  it("strips the syntax that would clutter a card tile", () => {
    const markdown = "# Goal\n\n- Use **bold** words\n- See the [docs](https://example.com)\n\n> quoted `code` and *soft* text";
    expect(plainTextFromMarkdown(markdown)).toBe("Goal Use bold words See the docs quoted code and soft text");
  });

  it("keeps snake_case identifiers intact", () => {
    expect(plainTextFromMarkdown("tune wizard_tower_door speed")).toBe("tune wizard_tower_door speed");
  });

  it("keeps code content while dropping the fences", () => {
    expect(plainTextFromMarkdown("```gdscript\nvar mana = 3\n```")).toBe("var mana = 3");
  });

  it("reduces images and task lists to their text", () => {
    expect(plainTextFromMarkdown("![tower sketch](sketch.png)\n\n- [x] model door\n- [ ] texture door")).toBe(
      "tower sketch model door texture door",
    );
  });
});
