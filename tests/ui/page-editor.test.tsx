// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace } from "../../shared/types";
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
    const panel = screen.getByRole("dialog", { name: "Edit page" });

    // Whichever half is showing, these are still the panel's own furniture.
    for (const selector of [".autosave-state", ".dialog-footer"]) {
      const element = panel.querySelector(selector);
      expect(element).not.toBeNull();
      expect(element!.closest(".page-editor-split")).toBeNull();
    }
  });
});
