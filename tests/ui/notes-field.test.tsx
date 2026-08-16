// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { uploadImage } from "../../src/api/client";
import { NotesField } from "../../src/components/NotesField";
import { plainTextFromMarkdown } from "../../src/components/markdown-text";

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, uploadImage: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(uploadImage).mockReset();
  vi.restoreAllMocks();
});

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
    // jsdom reports an unfocused document during synthetic tabbing; a browser
    // moving focus inside the page always reports a focused one.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
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

describe("NotesField Obsidian embeds", () => {
  it("renders ![[name]] embeds as project images the way Obsidian does", () => {
    const { container } = renderNotes("See ![[shot.png]] for the layout.");

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "/api/images/shot.png");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(screen.getByText(/for the layout/)).toBeInTheDocument();
  });

  it("honors Obsidian display sizes and alt modifiers", () => {
    const { container } = renderNotes("![[shot.png|300]]\n\n![[plan.png|300x200]]\n\n![[door.png|door sketch]]");

    const images = container.querySelectorAll("img");
    expect(images[0]).toHaveAttribute("width", "300");
    expect(images[0]).not.toHaveAttribute("height");
    expect(images[1]).toHaveAttribute("width", "300");
    expect(images[1]).toHaveAttribute("height", "200");
    expect(images[2]).toHaveAttribute("alt", "door sketch");
    expect(images[2]).not.toHaveAttribute("width");
  });

  it("leaves embeds inside code as literal text", () => {
    const { container } = renderNotes("Use `![[literal.png]]` to embed.\n\n```\n![[fenced.png]]\n```");

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("![[literal.png]]")).toBeInTheDocument();
    expect(screen.getByText("![[fenced.png]]")).toBeInTheDocument();
  });

  it("resolves hand-written relative image paths by file name", () => {
    const { container } = renderNotes("![goal](images/goal.png)");

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "/api/images/goal.png");
    expect(image).toHaveAttribute("alt", "goal");
  });

  it("leaves absolute image sources untouched", () => {
    const { container } = renderNotes("![chart](https://example.com/chart.png)");

    expect(container.querySelector("img")).toHaveAttribute("src", "https://example.com/chart.png");
  });
});

function PasteHarness() {
  const [value, setValue] = useState("Existing notes.");
  return (
    <NotesField
      editLabel="Edit notes"
      label="Notes"
      name="description"
      onChange={setValue}
      placeholder="Add only the context someone needs to act..."
      rows={6}
      textareaLabel="Notes"
      value={value}
    />
  );
}

describe("NotesField image paste", () => {
  it("uploads a pasted screenshot and embeds it Obsidian-style", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "pasted-image-20260807-183045-ab12.png" });
    render(<PasteHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "screenshot.png", { type: "image/png" });
    fireEvent.paste(textarea, { clipboardData: { files: [file] } });

    await waitFor(() =>
      expect(textarea).toHaveValue("Existing notes.![[pasted-image-20260807-183045-ab12.png]]"),
    );
    expect(uploadImage).toHaveBeenCalledWith(file);
  });

  it("removes the placeholder and reports when an upload fails", async () => {
    vi.mocked(uploadImage).mockRejectedValue(new Error("boom"));
    render(<PasteHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "screenshot.png", { type: "image/png" });
    fireEvent.paste(textarea, { clipboardData: { files: [file] } });

    await waitFor(() => expect(screen.getByText("image upload failed")).toBeInTheDocument());
    expect(textarea).toHaveValue("Existing notes.");
  });

  it("ignores pastes that contain no image", async () => {
    render(<PasteHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    fireEvent.paste(textarea, { clipboardData: { files: [] } });

    expect(uploadImage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Existing notes.");
  });

  it("accepts a drop on the rendered view and embeds on its own line", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "dropped.png" });
    const { container } = render(<PasteHarness />);

    const view = container.querySelector(".notes-view");
    expect(view).not.toBeNull();
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "sketch.png", { type: "image/png" });
    fireEvent.drop(view as Element, { dataTransfer: { files: [file], types: ["Files"] } });

    const textarea = await screen.findByRole("textbox", { name: "Notes" });
    await waitFor(() => expect(textarea).toHaveValue("Existing notes.\n\n![[dropped.png]]"));
    expect(uploadImage).toHaveBeenCalledWith(file);
  });

  it("shows the drop affordance while files drag across either mode", () => {
    const { container } = render(<PasteHarness />);
    const field = container.querySelector(".notes-field") as Element;

    fireEvent.dragEnter(field, { dataTransfer: { types: ["Files"], files: [] } });
    expect(field).toHaveClass("drop-active");
    fireEvent.dragLeave(field, { dataTransfer: { types: ["Files"], files: [] } });
    expect(field).not.toHaveClass("drop-active");

    fireEvent.dragEnter(field, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(field).not.toHaveClass("drop-active");
  });

  it("keeps the editor open when the window loses focus to another application", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus");
    render(<PasteHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const textarea = screen.getByRole("textbox", { name: "Notes" });

    hasFocus.mockReturnValue(false);
    fireEvent.blur(textarea);
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();

    hasFocus.mockReturnValue(true);
    fireEvent.blur(textarea);
    expect(screen.queryByRole("textbox", { name: "Notes" })).not.toBeInTheDocument();
    hasFocus.mockRestore();
  });
});

/**
 * jsdom has no layout and no Web Animations, so the heights and the animation are
 * supplied here. What is being checked is the arithmetic and the cleanup around
 * them, which is where a growing box goes wrong: the wrong pair of heights, or a
 * clip left behind over a field someone then focuses.
 */
describe("NotesField growth", () => {
  const RESTING = 70;
  const EDITING = 240;

  function stubLayout() {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains("notes-body")) return 0;
        return this.querySelector("textarea") ? EDITING : RESTING;
      },
    });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight"); });
  }

  function stubAnimate() {
    const animation = { addEventListener: vi.fn(), cancel: vi.fn() };
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate, writable: true });
    onTestFinished(() => { Reflect.deleteProperty(HTMLElement.prototype, "animate"); });
    return { animate, animation };
  }

  it("grows the notes from their resting height into the editor", async () => {
    stubLayout();
    const { animate } = stubAnimate();
    renderNotes("Charging past 80% should cost something.");

    await userEvent.click(screen.getByText("Charging past 80% should cost something."));

    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0];
    expect(frames).toEqual([{ height: `${RESTING}px` }, { height: `${EDITING}px` }]);
    expect(options.duration).toBe(190);
  });

  it("hands the box back to the stylesheet once the growth settles", async () => {
    stubLayout();
    const { animation } = stubAnimate();
    renderNotes("Charging past 80% should cost something.");

    await userEvent.click(screen.getByText("Charging past 80% should cost something."));

    const body = document.querySelector<HTMLElement>(".notes-body")!;
    expect(body.style.overflow).toBe("hidden");

    const finish = animation.addEventListener.mock.calls.find(([type]) => type === "finish")?.[1] as () => void;
    finish();
    expect(body.style.overflow).toBe("");
  });

  it("swaps without motion when the system asks for less of it", async () => {
    stubLayout();
    const { animate } = stubAnimate();
    // jsdom ships no matchMedia at all, which is why the hook reaches for it optionally.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }) as MediaQueryList,
      writable: true,
    });
    onTestFinished(() => { Reflect.deleteProperty(window, "matchMedia"); });
    renderNotes("Charging past 80% should cost something.");

    await userEvent.click(screen.getByText("Charging past 80% should cost something."));

    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("plainTextFromMarkdown", () => {
  it("strips the syntax that would clutter a page tile", () => {
    const markdown = "# Goal\n\n- Use **bold** words\n- See the [docs](https://example.com)\n\n> quoted `code` and *soft* text";
    expect(plainTextFromMarkdown(markdown)).toBe("Goal Use bold words See the docs quoted code and soft text");
  });

  it("keeps snake_case identifiers intact", () => {
    expect(plainTextFromMarkdown("tune wizard_tower_door speed")).toBe("tune wizard_tower_door speed");
  });

  it("drops Obsidian embeds from previews entirely", () => {
    expect(plainTextFromMarkdown("before ![[pasted-image.png]] after")).toBe("before after");
    expect(plainTextFromMarkdown("![[door.png|300]]\n\nThe door sketch.")).toBe("The door sketch.");
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
