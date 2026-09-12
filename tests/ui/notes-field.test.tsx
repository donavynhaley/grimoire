// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadImage } from "../../src/api/client";
import { NotesField } from "../../src/components/NotesField";
import { plainTextFromMarkdown } from "../../src/lib/markdown-text";

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, uploadImage: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(uploadImage).mockReset();
  vi.restoreAllMocks();
});

function notesElement(value: string, onChange: (value: string) => void = () => undefined) {
  return (
    <NotesField
      editLabel="Edit notes"
      editorLabel="Notes"
      label="Notes"
      onChange={onChange}
      placeholder="Add only the context someone needs to act..."
      rows={6}
      value={value}
      viewLabel="View notes"
    />
  );
}

async function renderNotes(value: string, onChange: (value: string) => void = () => undefined) {
  const view = render(notesElement(value, onChange));
  await screen.findByRole("textbox", { name: "Notes" });
  return view;
}

/** What the surface is currently showing, which is never the same as what it holds. */
function shown(): string {
  return (document.querySelector(".cm-content") as HTMLElement | null)?.textContent ?? "";
}

function surface(): HTMLElement {
  return document.querySelector(".cm-content") as HTMLElement;
}

describe("NotesField live preview", () => {
  it("draws what the Markdown produces instead of the Markdown", async () => {
    const { container } = await renderNotes("# Goal\n\nUse **bold** words and *quiet* ones.");

    expect(container.querySelector(".cm-lp-h1")).not.toBeNull();
    expect(container.querySelector(".cm-lp-strong")?.textContent).toBe("bold");
    expect(container.querySelector(".cm-lp-emphasis")?.textContent).toBe("quiet");
    // The syntax that produced all of that is not on screen while the caret is elsewhere.
    expect(shown()).not.toContain("**");
    expect(shown()).not.toContain("# ");
    expect(shown()).toContain("Goal");
    expect(shown()).toContain("bold");
  });

  it("keeps the whole document, not just the part it is drawing", async () => {
    const changes: string[] = [];
    await renderNotes("**bold**", (value) => changes.push(value));

    // Nothing was rewritten to make it render: the notes still say what they said.
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
    expect(changes).toHaveLength(0);
  });

  it("shows a link as a link and follows it rather than editing it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = await renderNotes("A [reference](https://example.com) worth reading.");

    const link = container.querySelector(".cm-lp-link") as HTMLElement;
    expect(link.textContent).toBe("reference");
    expect(shown()).not.toContain("https://example.com");

    fireEvent.mouseDown(link);
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noreferrer");
  });

  it("shows raw HTML as text rather than injecting it", async () => {
    await renderNotes('<img src="x" onerror="alert(1)">definitely text');

    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(shown()).toContain("definitely text");
  });

  it("draws a rule, a quote, and a bullet as themselves", async () => {
    const { container } = await renderNotes("> quoted\n\n- first\n- second\n\n---");

    expect(container.querySelector(".cm-lp-quote")).not.toBeNull();
    expect(container.querySelectorAll(".cm-lp-bullet")).toHaveLength(2);
    expect(container.querySelector("hr.cm-lp-rule")).not.toBeNull();
    expect(shown()).not.toContain(">");
  });

  it("draws a table as a table, because no hidden pipe makes rows into columns", async () => {
    const { container } = await renderNotes("| Part | Owner |\n| --- | ---: |\n| Door | Ana |");

    const table = container.querySelector(".cm-lp-table table");
    expect(table).not.toBeNull();
    const headers = table?.querySelectorAll("th:not(.cm-lp-table-grow)") ?? [];
    expect(headers).toHaveLength(2);
    expect(headers[0]!.textContent).toBe("Part");
    expect(table?.querySelector("td:not(.cm-lp-table-grow)")?.textContent).toBe("Door");
    expect((headers[1] as HTMLElement).style.textAlign).toBe("right");
  });

  it("grows a table by a column, and squares the source back up", async () => {
    const written: string[] = [];
    function TableHarness() {
      const [value, setValue] = useState("| Part | Owner |\n| --- | ---: |\n| Door | Ana |");
      return notesElement(value, (next) => {
        written.push(next);
        setValue(next);
      });
    }
    render(<TableHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.mouseDown(screen.getByRole("button", { name: "Add a column" }));

    await waitFor(() =>
      expect(written.at(-1)).toBe("| Part | Owner |     |\n| ---- | ----: | --- |\n| Door | Ana   |     |"),
    );
  });

  it("grows a table by a row", async () => {
    const written: string[] = [];
    function TableHarness() {
      const [value, setValue] = useState("| Part | Owner |\n| --- | --- |\n| Door | Ana |");
      return notesElement(value, (next) => {
        written.push(next);
        setValue(next);
      });
    }
    render(<TableHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.mouseDown(screen.getByRole("button", { name: "Add a row" }));

    await waitFor(() =>
      expect(written.at(-1)).toBe("| Part | Owner |\n| ---- | ----- |\n| Door | Ana   |\n|      |       |"),
    );
  });

  it("takes a click on a cell as a request to write in that cell", async () => {
    const { container } = await renderNotes("| Part | Owner |\n| --- | --- |\n| Door | Ana |");

    const ana = Array.from(container.querySelectorAll("td")).find((cell) => cell.textContent === "Ana");
    expect(ana).toBeDefined();
    fireEvent.mouseDown(ana as Element);

    // The caret went into the table, so the table is showing its workings rather than its shape.
    await waitFor(() => expect(container.querySelector(".cm-lp-table")).toBeNull());
    expect(shown()).toContain("| Door | Ana |");
  });

  it("keeps a fenced block as the characters it contains", async () => {
    const { container } = await renderNotes("```\nconst door = 1;\n```");

    expect(container.querySelector(".cm-lp-code-line")).not.toBeNull();
    expect(shown()).toContain("const door = 1;");
  });
});

describe("NotesField Obsidian embeds", () => {
  it("renders ![[name]] embeds as project images the way Obsidian does", async () => {
    const { container } = await renderNotes("See ![[shot.png]] for the layout.");

    const image = container.querySelector("img.cm-lp-image");
    expect(image).toHaveAttribute("src", "/api/images/shot.png");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(shown()).toContain("for the layout");
    expect(shown()).not.toContain("![[shot.png]]");
  });

  it("honors Obsidian display sizes and alt modifiers", async () => {
    const { container } = await renderNotes(
      "![[shot.png|300]]\n\n![[plan.png|300x200]]\n\n![[door.png|door sketch]]",
    );

    const images = container.querySelectorAll("img.cm-lp-image");
    expect(images[0]).toHaveAttribute("width", "300");
    expect(images[0]).not.toHaveAttribute("height");
    expect(images[1]).toHaveAttribute("width", "300");
    expect(images[1]).toHaveAttribute("height", "200");
    expect(images[2]).toHaveAttribute("alt", "door sketch");
    expect(images[2]).not.toHaveAttribute("width");
  });

  it("leaves embeds inside code as literal text", async () => {
    const { container } = await renderNotes("Use `![[literal.png]]` to embed.\n\n```\n![[fenced.png]]\n```");

    expect(container.querySelector("img.cm-lp-image")).toBeNull();
    expect(shown()).toContain("![[literal.png]]");
    expect(shown()).toContain("![[fenced.png]]");
  });

  it("resolves hand-written relative image paths by file name", async () => {
    const { container } = await renderNotes("![goal](images/goal.png)");

    const image = container.querySelector("img.cm-lp-image");
    expect(image).toHaveAttribute("src", "/api/images/goal.png");
    expect(image).toHaveAttribute("alt", "goal");
  });

  it("leaves absolute image sources untouched", async () => {
    const { container } = await renderNotes("![chart](https://example.com/chart.png)");

    expect(container.querySelector("img.cm-lp-image")).toHaveAttribute(
      "src",
      "https://example.com/chart.png",
    );
  });
});

describe("NotesField task checkboxes", () => {
  it("ticks a task where it stands, without going to find its syntax", async () => {
    function TaskHarness() {
      const [value, setValue] = useState("- [ ] hang the door");
      return notesElement(value, setValue);
    }
    const { container } = render(<TaskHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    const box = container.querySelector("input.cm-lp-task") as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.mouseDown(box);

    await waitFor(() =>
      expect((container.querySelector("input.cm-lp-task") as HTMLInputElement).checked).toBe(true),
    );
  });

  it("hands the box back as [ ] once the caret is on its line", async () => {
    const { container } = await renderNotes("- [ ] hang the door");
    expect(container.querySelector("input.cm-lp-task")).not.toBeNull();

    surface().focus();

    // A box that stayed a box would have no characters for the caret to walk into.
    await waitFor(() => expect(container.querySelector("input.cm-lp-task")).toBeNull());
    expect(shown()).toContain("[ ]");
  });
});

/**
 * Notes that report what they now hold, which is not what they are showing.
 *
 * An embed that has just been pasted is on the line the caret is on, so the surface is
 * showing that line's source - the reference itself - rather than the picture. That is the
 * whole point of the thing, so these tests read the notes rather than the screen, and the
 * one that cares about the picture moves the caret away first.
 */
function PasteHarness({ onValue }: { onValue?: (value: string) => void } = {}) {
  const [value, setValue] = useState("Existing notes.");
  return notesElement(value, (next) => {
    onValue?.(next);
    setValue(next);
  });
}

describe("NotesField image paste", () => {
  const png = () => new File([Uint8Array.from([137, 80, 78, 71])], "screenshot.png", { type: "image/png" });
  /** A clipboard the editor can also read text out of, the way a real one would. */
  const clipboard = (files: File[]) => ({
    files,
    items: [],
    types: files.length ? ["Files"] : [],
    getData: () => "",
  });

  it("uploads a pasted screenshot and embeds it Obsidian-style", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "pasted-image-20260807-183045-ab12.png" });
    const written: string[] = [];
    render(<PasteHarness onValue={(value) => written.push(value)} />);
    await screen.findByRole("textbox", { name: "Notes" });

    const file = png();
    fireEvent.paste(surface(), { clipboardData: clipboard([file]) });

    await waitFor(() =>
      expect(written.at(-1)).toBe("Existing notes.\n\n![[pasted-image-20260807-183045-ab12.png]]"),
    );
    expect(uploadImage).toHaveBeenCalledWith(file);
  });

  it("draws the picture once the caret is no longer standing on it", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "settled.png" });
    const { container } = render(<PasteHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.paste(surface(), { clipboardData: clipboard([png()]) });
    await waitFor(() => expect(uploadImage).toHaveBeenCalled());

    // Really leaving, not just being told about it: the editor reads focus off the document.
    surface().blur();

    await waitFor(() =>
      expect(container.querySelector("img.cm-lp-image")).toHaveAttribute("src", "/api/images/settled.png"),
    );
  });

  it("removes the placeholder and reports when an upload fails", async () => {
    vi.mocked(uploadImage).mockRejectedValue(new Error("boom"));
    render(<PasteHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.paste(surface(), { clipboardData: clipboard([png()]) });

    await waitFor(() => expect(screen.getByText("image upload failed")).toBeInTheDocument());
    await waitFor(() => expect(shown()).toBe("Existing notes."));
  });

  it("takes an image from the picker, which is the only route a phone has", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "from-camera-roll.png" });
    const written: string[] = [];
    const { container } = render(<PasteHarness onValue={(value) => written.push(value)} />);
    await screen.findByRole("textbox", { name: "Notes" });

    expect(screen.getByRole("button", { name: "Add an image" })).toBeInTheDocument();
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker).toHaveAttribute("accept", "image/*");

    const file = new File([Uint8Array.from([137, 80, 78, 71])], "photo.png", { type: "image/png" });
    fireEvent.change(picker, { target: { files: [file] } });

    await waitFor(() => expect(uploadImage).toHaveBeenCalledWith(file));
    // It arrived while nobody was writing, so it went to the end on a line of its own.
    await waitFor(() => expect(written.at(-1)).toBe("Existing notes.\n\n![[from-camera-roll.png]]"));
  });

  it("ignores pastes that contain no image", async () => {
    render(<PasteHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.paste(surface(), { clipboardData: clipboard([]) });

    expect(uploadImage).not.toHaveBeenCalled();
    expect(shown()).toBe("Existing notes.");
  });

  it("accepts a drop anywhere on the field and embeds on its own line", async () => {
    vi.mocked(uploadImage).mockResolvedValue({ name: "dropped.png" });
    const written: string[] = [];
    const { container } = render(<PasteHarness onValue={(value) => written.push(value)} />);
    await screen.findByRole("textbox", { name: "Notes" });

    const field = container.querySelector(".notes-field") as Element;
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "sketch.png", { type: "image/png" });
    fireEvent.drop(field, { dataTransfer: { files: [file], types: ["Files"], getData: () => "" } });

    await waitFor(() => expect(written.at(-1)).toBe("Existing notes.\n\n![[dropped.png]]"));
  });

  it("shows the drop affordance while files drag across the field", async () => {
    const { container } = render(<PasteHarness />);
    await screen.findByRole("textbox", { name: "Notes" });
    const field = container.querySelector(".notes-field") as Element;

    fireEvent.dragEnter(field, { dataTransfer: { files: [], types: ["Files"] } });
    expect(field.className).toContain("drop-active");

    fireEvent.dragLeave(field, { dataTransfer: { files: [], types: ["Files"] } });
    expect(field.className).not.toContain("drop-active");
  });
});

describe("NotesField source mode", () => {
  it("hands over the Markdown itself, and offers the drawn document back", async () => {
    const { container } = await renderNotes("# Goal\n\nUse **bold** words and ![[shot.png]] beside them.");
    expect(container.querySelector(".cm-lp-h1")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));

    await waitFor(() => expect(container.querySelector(".cm-lp-h1")).toBeNull());
    expect(container.querySelector(".cm-lp-strong")).toBeNull();
    expect(container.querySelector("img.cm-lp-image")).toBeNull();
    expect(shown()).toContain("# Goal");
    expect(shown()).toContain("**bold**");
    expect(shown()).toContain("![[shot.png]]");
    // The word on the control is what a click will do next, so it is now the way back.
    expect(screen.getByRole("button", { name: "View notes" })).toHaveTextContent("view");

    await userEvent.click(screen.getByRole("button", { name: "View notes" }));

    await waitFor(() => expect(container.querySelector(".cm-lp-h1")).not.toBeNull());
    expect(shown()).not.toContain("**");
    expect(screen.getByRole("button", { name: "Edit notes" })).toHaveTextContent("edit");
  });

  it("changes what is drawn and never what is written", async () => {
    const changes: string[] = [];
    await renderNotes("# Goal\n\n- [ ] hang the door", (value) => changes.push(value));

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await waitFor(() => expect(shown()).toContain("# Goal"));
    await userEvent.click(screen.getByRole("button", { name: "View notes" }));

    expect(changes).toHaveLength(0);
  });

  it("brings the caret with it, because asking for the Markdown is asking to write in it", async () => {
    await renderNotes("notes");

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));

    await waitFor(() => expect(surface()).toHaveFocus());
  });
});

describe("NotesField as a controlled field", () => {
  it("reports what was typed without being told what to show", async () => {
    const changes: string[] = [];
    function TypingHarness() {
      const [value, setValue] = useState("");
      return notesElement(value, (next) => {
        changes.push(next);
        setValue(next);
      });
    }
    render(<TypingHarness />);
    await screen.findByRole("textbox", { name: "Notes" });

    await userEvent.type(surface(), "hello");

    await waitFor(() => expect(changes.at(-1)).toBe("hello"));
  });

  it("adopts a value that arrived from somewhere else", async () => {
    const { rerender } = render(notesElement("mine"));
    expect(shown()).toBe("mine");

    rerender(notesElement("theirs, adopted while this field sat untouched"));

    await waitFor(() => expect(shown()).toBe("theirs, adopted while this field sat untouched"));
  });

  it("names the surface and offers the same destination to a keyboard", async () => {
    await renderNotes("notes");

    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit notes" })).toBeInTheDocument();
  });

  it("carries the resting height the rows asked for", async () => {
    const { container } = await renderNotes("");

    expect(
      (container.querySelector(".notes-field") as HTMLElement).style.getPropertyValue("--notes-rows"),
    ).toBe("6");
  });
});

describe("plainTextFromMarkdown", () => {
  it("strips the syntax that would clutter a page tile", async () => {
    const text = plainTextFromMarkdown(
      "# Goal\n\nUse **bold** and [a link](https://example.com).\n\n- one\n- two",
    );
    expect(text).toBe("Goal Use bold and a link. one two");
  });

  it("keeps snake_case identifiers intact", async () => {
    expect(plainTextFromMarkdown("open wizard_tower_door now")).toBe("open wizard_tower_door now");
  });

  it("drops Obsidian embeds from previews entirely", async () => {
    expect(plainTextFromMarkdown("before ![[shot.png]] after")).toBe("before after");
  });

  it("keeps code content while dropping the fences", async () => {
    expect(plainTextFromMarkdown("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("reduces images and task lists to their text", async () => {
    expect(plainTextFromMarkdown("- [x] ![shot](a.png) done")).toBe("shot done");
  });
});
