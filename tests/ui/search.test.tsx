// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { SearchResults } from "../../shared/types";
import { boardFixture, ideaFixture } from "../fixtures/board";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const results: SearchResults = {
  query: "door",
  total: 3,
  hits: [
    {
      kind: "card",
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
      kind: "card",
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

function stubFetch(board = boardFixture(), search: SearchResults = results) {
  const mock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => response({ status: "authenticated", user: board.currentUser }))
    .mockImplementationOnce(() => response(board));
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    if (url.startsWith("/api/search")) return response(search);
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/seen")) return response({ ok: true });
    if (url.startsWith("/api/ideas")) return response(ideaFixture());
    return mock(input, init);
  });
  return mock;
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
    const capture = await screen.findByLabelText("Capture work card");
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
    const groups = [...dialog.querySelectorAll(".search-group-label")].map((label) => label.textContent?.trim());
    expect(groups).toEqual(["Backlog 1", "Ideas 1", "Archived 1"]);
    expect(within(dialog).getByText("Doors that recognise who knocked")).toBeInTheDocument();
    expect(within(dialog).getByText("Archived Aug 2026")).toBeInTheDocument();
  });

  it("opens a backlog card the board was hiding", async () => {
    stubFetch();

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");
    await userEvent.click(await screen.findByText("Make the tower door remember Maren"));

    const card = await screen.findByRole("dialog", { name: "Edit card" });
    expect(within(card).getByLabelText("Title")).toHaveValue("Make the tower door remember Maren");
  });

  it("leaves archived results readable but not openable", async () => {
    stubFetch();

    render(<App />);
    const dialog = await openSearch();
    await userEvent.type(within(dialog).getByRole("searchbox"), "door");
    await screen.findByText("Old door prototype");

    // An archived card has no editable home to return to; the snippet is the answer.
    const buttons = within(dialog).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(buttons.some((label) => label.includes("Old door prototype"))).toBe(false);
    expect(within(dialog).getByText("Replaced by the tower door work.")).toBeInTheDocument();
  });

  it("tells the board filter to stop pretending it searched everything", async () => {
    stubFetch();

    render(<App />);
    await screen.findByRole("button", { name: /open backlog/i });
    await userEvent.type(screen.getByLabelText("Search cards"), "tower door");

    // One backlog card matches and the board has no column to show it in.
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
