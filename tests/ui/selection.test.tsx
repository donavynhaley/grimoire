// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Page } from "../../shared/types";
import { App } from "../../src/App";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, routeFetch } from "../fixtures/ui";

installUiHarness();

/** Three cards in one column, so a run of them exists to be selected. */
function boardWithColumn() {
  const base = boardFixture();
  const seed = base.pages[1]!;
  const pages: Page[] = ["Alpha", "Bravo", "Charlie"].map((title, index) => ({
    ...seed,
    id: `00000000-0000-4000-8000-00000000009${index}`,
    title,
    status: "ready",
    position: index,
    blockedBy: [],
  }));
  return { ...base, pages };
}

const tile = (title: string) => screen.getByRole("button", { name: new RegExp(`^Open ${title}\\b`) });

describe("holding several cards at once", () => {
  it("selects on a held modifier and still opens on a plain click", async () => {
    const user = userEvent.setup();
    routeFetch({ board: boardWithColumn() });
    render(<App />);
    await screen.findByText("Alpha");

    // The modifier is what means selection; nothing about the ordinary click changes.
    await user.keyboard("{Control>}");
    await user.click(tile("Alpha"));
    await user.keyboard("{/Control}");

    expect(screen.queryByRole("dialog", { name: "Edit page" })).toBeNull();
    expect(await screen.findByText("selected")).toBeInTheDocument();

    await user.click(tile("Bravo"));
    await screen.findByRole("dialog", { name: "Edit page" });
  });

  it("takes the run between the anchor and a shift-click", async () => {
    const user = userEvent.setup();
    routeFetch({ board: boardWithColumn() });
    render(<App />);
    await screen.findByText("Alpha");

    await user.keyboard("{Control>}");
    await user.click(tile("Alpha"));
    await user.keyboard("{/Control}");
    await user.keyboard("{Shift>}");
    await user.click(tile("Charlie"));
    await user.keyboard("{/Shift}");

    const bar = screen.getByRole("group", { name: "Selected pages" });
    expect(bar).toHaveTextContent("3");
    // Every card in the run says so for itself, not only the bar's count.
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      expect(tile(title)).toHaveAccessibleName(/Selected$/);
    }
  });

  it("applies one decision to every held page and asks the server once per page", async () => {
    const user = userEvent.setup();
    const board = boardWithColumn();
    const { calls } = routeFetch({ board });
    render(<App />);
    await screen.findByText("Alpha");

    await user.keyboard("{Control>}");
    await user.click(tile("Alpha"));
    await user.click(tile("Charlie"));
    await user.keyboard("{/Control}");

    await user.click(screen.getByRole("button", { name: "column" }));
    await user.click(screen.getByRole("button", { name: "Move 2 pages to Review" }));

    await waitFor(() => {
      const patches = calls.filter((call) => call.method === "PATCH");
      expect(patches.map((call) => call.url)).toEqual([
        `/api/pages/${board.pages[0]!.id}`,
        `/api/pages/${board.pages[2]!.id}`,
      ]);
      // Bravo sat between them and was never held, so it is never written.
      expect(patches.every((call) => (call.body as { status?: string }).status === "review")).toBe(true);
    });
  });

  it("puts the selection down on Escape", async () => {
    const user = userEvent.setup();
    routeFetch({ board: boardWithColumn() });
    render(<App />);
    await screen.findByText("Alpha");

    await user.keyboard("{Control>}");
    await user.click(tile("Alpha"));
    await user.keyboard("{/Control}");
    expect(screen.getByRole("group", { name: "Selected pages" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Selected pages" })).toBeNull());
  });

  it("lets a keyboard hold a card, which a modified Enter alone cannot do", async () => {
    const user = userEvent.setup();
    routeFetch({ board: boardWithColumn() });
    render(<App />);
    await screen.findByText("Alpha");

    // The browser suppresses activation for a modified Enter, so no click is ever produced;
    // the tile hears the key itself, which is what keeps this reachable without a pointer.
    tile("Alpha").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(screen.queryByRole("dialog", { name: "Edit page" })).toBeNull();
    expect(screen.getByRole("group", { name: "Selected pages" })).toHaveTextContent("1");
  });
});
