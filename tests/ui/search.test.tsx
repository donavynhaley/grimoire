// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, SearchResults } from "../../shared/types";
import { boardFixture, ideaFixture } from "../fixtures/board";
import { installUiHarness, routeFetch, type RouteReply } from "../fixtures/ui";

installUiHarness();

const results: SearchResults = {
  query: "door",
  total: 3,
  hits: [
    {
      kind: "page",
      group: "backlog",
      id: "00000000-0000-4000-8000-000000000020",
      title: "Make the tower door remember Maren",
      snippet: "A small story interaction for the first room.",
      where: "Backlog",
      category: "Narrative",
      categoryColor: "#a99bdc",
      assigneeName: null,
    },
    {
      kind: "idea",
      group: "ideas",
      id: "00000000-0000-4000-8000-000000000040",
      title: "Doors that recognise who knocked",
      snippet: "",
      where: "Shortlist",
      category: null,
      categoryColor: null,
      assigneeName: null,
    },
    {
      kind: "page",
      group: "archived",
      id: "00000000-0000-4000-8000-000000000099",
      title: "Old door prototype",
      snippet: "Replaced by the tower door work.",
      where: "Archived Aug 2026",
      category: null,
      categoryColor: null,
      assigneeName: null,
    },
  ],
};

/** Stubs the canned results behind /api/search; extra routes carry a test's own writes. */
function stubFetch(
  board: BoardWorkspace | (() => BoardWorkspace) = boardFixture(),
  routes: Record<string, RouteReply> = {},
) {
  return routeFetch({
    board,
    routes: { "GET /api/search": results, "GET /api/ideas": ideaFixture(), ...routes },
  }).fetchMock;
}

async function openSearch() {
  await screen.findByRole("button", { name: /open backlog/i });
  await userEvent.keyboard("/");
  return screen.findByRole("dialog", { name: "Search everything" });
}

describe("searching the whole project", () => {
  it("opens with a slash from an empty capture field, without typing the slash", async () => {
    stubFetch();

    render(<App />);
    const capture = await screen.findByLabelText("Capture work page");
    expect(capture).toHaveFocus();

    await openSearch();

    expect(capture).toHaveValue("");
  });

  it("groups results by where they live, including places the board cannot draw", async () => {
    stubFetch();

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");

    await screen.findByText("Make the tower door remember Maren");
    const groups = [...dialog.querySelectorAll(".search-group-label")].map((label) =>
      label.textContent?.trim(),
    );
    expect(groups).toEqual(["Backlog 1", "Ideas 1", "Archived 1"]);
    expect(within(dialog).getByText("Doors that recognise who knocked")).toBeInTheDocument();
    expect(within(dialog).getByText("Archived Aug 2026")).toBeInTheDocument();
  });

  it("opens a backlog page the board was hiding", async () => {
    stubFetch();

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");
    await userEvent.click(await screen.findByText("Make the tower door remember Maren"));

    const page = await screen.findByRole("dialog", { name: "Edit page" });
    expect(within(page).getByLabelText("Title")).toHaveValue("Make the tower door remember Maren");
  });

  it("offers an archived page its way back instead of opening it", async () => {
    stubFetch();

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");
    await screen.findByText("Old door prototype");

    // An archived page has no editable home to open, so the row reads and restores.
    const rows = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(rows.some((label) => label.includes("Old door prototype"))).toBe(false);
    expect(within(dialog).getByText("Replaced by the tower door work.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Restore Old door prototype" })).toBeInTheDocument();
  });

  it("restores an archived page and shows where it landed", async () => {
    const board = boardFixture();
    const restored = {
      ...board.pages[0]!,
      id: "00000000-0000-4000-8000-000000000099",
      title: "Old door prototype",
      status: "backlog" as const,
    };
    let workspace = board;
    const mock = stubFetch(() => workspace, {
      [`POST /api/pages/${restored.id}/restore`]: () => {
        workspace = { ...board, pages: [restored, ...board.pages] };
        return { page: restored };
      },
    });

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");
    await userEvent.click(await screen.findByRole("button", { name: "Restore Old door prototype" }));

    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        `/api/pages/${restored.id}/restore`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // A page returns to the column it was archived from, which the board may not draw,
    // so the page itself answers where it went.
    const page = await screen.findByRole("dialog", { name: "Edit page" });
    expect(within(page).getByLabelText("Title")).toHaveValue("Old door prototype");
    expect(screen.queryByRole("dialog", { name: "Search everything" })).not.toBeInTheDocument();
  });

  it("tells the board filter to stop pretending it searched everything", async () => {
    stubFetch();

    render(<App />);
    await screen.findByRole("button", { name: /open backlog/i });
    await userEvent.type(screen.getByLabelText("Search pages"), "tower door");

    // One backlog page matches and the board has no column to show it in.
    expect(await screen.findByText("1 in Backlog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /search everything/i }));

    const dialog = await screen.findByRole("dialog", { name: "Search everything" });
    expect(within(dialog).getByRole("searchbox")).toHaveValue("tower door");
  });

  it("closes on Escape", async () => {
    stubFetch();

    render(<App />);
    await openSearch();

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search everything" })).not.toBeInTheDocument(),
    );
  });
});
