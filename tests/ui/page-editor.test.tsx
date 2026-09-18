// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BoardWorkspace } from "../../shared/types";
import { App } from "../../src/App";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, routeFetch } from "../fixtures/ui";

installUiHarness();

function mountWith(board: BoardWorkspace) {
  routeFetch({ board });
  render(<App />);
}

/**
 * Which half of the editor is on screen is a choice the panel keeps and the stylesheet
 * honours - so what is asserted here is the choice, and the e2e suite holds the sheet to
 * the widths where it actually changes what you can see.
 */
describe("the page editor's two halves", () => {
  it("opens on the writing and stays pointed at whichever half was asked for", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    await screen.findByRole("dialog", { name: "Edit page" });
    const split = document.querySelector(".page-editor-split");
    // The strip is the one that chooses down here; the second column has a switch of its own
    // for what it holds, and that one is hidden at these widths.
    const tabs = within(document.querySelector(".page-editor-panes") as HTMLElement);
    expect(split).toHaveAttribute("data-pane", "notes");

    await user.click(tabs.getByRole("button", { name: "Details" }));
    expect(split).toHaveAttribute("data-pane", "aside");

    await user.click(tabs.getByRole("button", { name: "Notes" }));
    expect(split).toHaveAttribute("data-pane", "notes");

    // Both halves of the second column are reachable from the same strip.
    await user.click(tabs.getByRole("button", { name: /Discussion/ }));
    expect(split).toHaveAttribute("data-pane", "aside");
    expect(document.querySelector(".page-discussion")).toBeTruthy();
  });

  it("keeps the archive and the autosave line out of both halves, under them", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    const panel = await screen.findByRole("dialog", { name: "Edit page" });

    // Whichever half is showing, these are still the panel's own furniture.
    for (const selector of [".autosave-state", ".dialog-footer"]) {
      const element = panel.querySelector(selector);
      expect(element).not.toBeNull();
      expect(element!.closest(".page-editor-split")).toBeNull();
    }
  });
});

/** jsdom exposes `navigator.clipboard` through a getter, so it is redefined rather than set. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}
/**
 * Copying is delegating, and delegating is not starting: the board must do nothing at all
 * when this is pressed, which is as much of the contract as the format itself.
 */
describe("handing a page to an agent", () => {
  it("copies the deep link and the page's name, and nothing from the brief", async () => {
    const user = userEvent.setup();
    const base = boardFixture();
    // The page carries notes, so "the brief is not copied" is a real assertion rather than
    // one that passes on an empty string.
    const page = { ...base.pages[1]!, description: "The workbench holds three reagent slots." };
    const board = { ...base, pages: [page, ...base.pages.slice(2)] };
    const written: string[] = [];
    stubClipboard((text) => {
      written.push(text);
      return Promise.resolve();
    });
    const { fetchMock } = routeFetch({ board });
    render(<App />);

    await user.click(await screen.findByText(page.title));
    await screen.findByRole("dialog", { name: "Edit page" });
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Copy for agent" }));

    expect(written).toEqual([
      [
        `Grimoire page ${page.id} in project "${board.project.name}"`,
        page.title,
        `${window.location.origin}/?project=${board.project.id}&page=${page.id}`,
      ].join("\n"),
    ]);
    // The notes are read through the agent's own credential against the page that is
    // current; a copy of them here would fork the brief where the discussion cannot follow.
    expect(written[0]).not.toContain(page.description);
    // Nothing started, nothing was assigned, nothing was recorded.
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(await screen.findByText("Copied for agent")).toBeInTheDocument();
  });

  it("shows the block to copy by hand when the clipboard is refused", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    const page = board.pages[1]!;
    stubClipboard(() => Promise.reject(new Error("denied")));
    routeFetch({ board });
    render(<App />);

    await user.click(await screen.findByText(page.title));
    await screen.findByRole("dialog", { name: "Edit page" });
    await user.click(screen.getByRole("button", { name: "Copy for agent" }));

    // A refusal is not an error: selecting the block by hand still does the job.
    const block = await screen.findByText(`Grimoire page ${page.id}`, { exact: false });
    expect(block).toHaveTextContent(`${window.location.origin}/?project=${board.project.id}&page=${page.id}`);
    expect(screen.queryByText("Copied for agent")).toBeNull();
  });
});
