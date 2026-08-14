// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, Card, Chapter } from "../../shared/types";
import { boardFixture } from "../fixtures/board";

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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? `${input.pathname}${input.search}` : input.url;
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    slug: "first-brew",
    name: "First Brew",
    description: "Get one full potion loop playable end to end.",
    state: "open",
    position: 0,
    startsOn: "2026-08-18",
    endsOn: "2026-09-15",
    createdById: "00000000-0000-4000-8000-000000000010",
    createdByName: "Donavyn",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function card(overrides: Partial<Card>): Card {
  const base = boardFixture().cards[1];
  return { ...base, ...overrides };
}

/** A board with chapters on, one open chapter, and cards on both sides of it. */
function chapteredBoard(): BoardWorkspace {
  const board = boardFixture();
  return {
    ...board,
    project: { ...board.project, chaptersEnabled: true },
    chapters: [chapter(), chapter({ slug: "second-brew", name: "Second Brew", state: "planned", startsOn: null, endsOn: null })],
    cards: [
      card({ id: "card-in", title: "Inside the chapter", chapter: "first-brew", status: "ready", position: 0 }),
      card({ id: "card-out", title: "Outside the chapter", chapter: null, status: "ready", position: 1 }),
      card({ id: "card-backlog", title: "Reserved for later", chapter: "first-brew", status: "backlog", position: 0 }),
      card({ id: "card-unplaced", title: "Waiting to be placed", chapter: null, status: "backlog", position: 1 }),
    ],
  };
}

function mountWith(board: BoardWorkspace) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/seen")) return response({ ok: true });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
}

describe("chapters on the board", () => {
  it("shows no chapter control at all when the project has not enabled them", async () => {
    mountWith(boardFixture());

    await screen.findByRole("button", { name: /Open backlog/ });
    expect(screen.queryByRole("button", { name: /Filter by chapter/ })).toBeNull();
  });

  it("opens on the current chapter and narrows the columns to it", async () => {
    mountWith(chapteredBoard());

    const trigger = await screen.findByRole("button", { name: /Filter by chapter/ });
    expect(trigger).toHaveAccessibleName(/First Brew/);

    // The chapter's own card is on the board; the unplaced one is filtered out.
    expect(await screen.findByText("Inside the chapter")).toBeInTheDocument();
    expect(screen.queryByText("Outside the chapter")).toBeNull();
  });

  it("names the chapter and its dates instead of a bare card count", async () => {
    mountWith(chapteredBoard());

    expect(await screen.findByRole("heading", { name: "First Brew", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Get one full potion loop playable end to end\./)).toBeInTheDocument();
  });

  it("reports the chapter's backlog reserve without leaving the board", async () => {
    mountWith(chapteredBoard());

    // One of the chapter's cards is still in the Backlog, which the board cannot draw.
    expect(await screen.findByText("1 in Backlog")).toBeInTheDocument();
  });

  it("widens back to every card through All work, and records it in the URL", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /All work/ }));

    expect(await screen.findByText("Outside the chapter")).toBeInTheDocument();
    expect(screen.getByText("Inside the chapter")).toBeInTheDocument();
    // All work is the absence of a filter, so it leaves no chapter in the address bar.
    await waitFor(() => expect(new URLSearchParams(location.search).get("chapter")).toBeNull());
  });

  it("filters to cards nobody has placed", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /No chapter/ }));

    expect(await screen.findByText("Outside the chapter")).toBeInTheDocument();
    expect(screen.queryByText("Inside the chapter")).toBeNull();
    await waitFor(() => expect(new URLSearchParams(location.search).get("chapter")).toBe("none"));
  });

  it("opens on the chapter named in the URL rather than the open one", async () => {
    window.history.replaceState({}, "", "/?chapter=second-brew");
    mountWith(chapteredBoard());

    const trigger = await screen.findByRole("button", { name: /Filter by chapter/ });
    expect(trigger).toHaveAccessibleName(/Second Brew/);
    // Second Brew holds nothing yet, so the board is honestly empty rather than showing
    // the other chapter's work.
    expect(screen.queryByText("Inside the chapter")).toBeNull();
  });

  it("falls back to all work when the URL names a chapter that no longer exists", async () => {
    window.history.replaceState({}, "", "/?chapter=deleted-one");
    mountWith(chapteredBoard());

    const trigger = await screen.findByRole("button", { name: /Filter by chapter/ });
    expect(trigger).toHaveAccessibleName(/All work/);
    expect(await screen.findByText("Outside the chapter")).toBeInTheDocument();
  });

  it("keeps the chapter filter alongside a people filter", async () => {
    const user = userEvent.setup();
    const board = chapteredBoard();
    mountWith(board);

    await screen.findByText("Inside the chapter");
    await user.click(screen.getByRole("button", { name: "unassigned" }));

    // Both filters apply: the chapter's card is assigned, so nothing survives.
    await waitFor(() => expect(screen.queryByText("Inside the chapter")).toBeNull());
    expect(new URLSearchParams(location.search).get("chapter")).toBe("first-brew");
    expect(new URLSearchParams(location.search).get("people")).toBe("unassigned");
  });
});

describe("pulling from the backlog", () => {
  it("offers the viewed chapter on every row and leaves the card in the Backlog", async () => {
    const user = userEvent.setup();
    const board = chapteredBoard();
    const patched: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
      if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
      if (url.startsWith("/api/seen")) return response({ ok: true });
      if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
      if (init?.method === "PATCH") {
        patched.push(JSON.parse(String(init.body)));
        return response({ card: board.cards[0] });
      }
      return response(board);
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Open backlog/ }));
    const dialog = await screen.findByRole("dialog", { name: "Backlog" });
    await user.click(within(dialog).getByRole("button", { name: /Add Waiting to be placed to First Brew/ }));

    // The pull sets only the chapter. It never touches the column, which is what stops a
    // chapter being filled from flooding Up Next.
    expect(patched).toEqual([{ chapter: "first-brew" }]);
  });

  it("shows a card already in the chapter as a state rather than an action", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Open backlog/ }));
    const dialog = await screen.findByRole("dialog", { name: "Backlog" });

    expect(within(dialog).getByRole("button", { name: /Remove Reserved for later from First Brew/ })).toBeInTheDocument();
  });
});

describe("closing a chapter", () => {
  it("asks what should happen to unfinished work and does nothing on its own", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /Manage chapters/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chapters" });
    await user.click(within(dialog).getByRole("button", { name: "close" }));

    // Two of First Brew's cards are unfinished, and every route out is a named choice.
    expect(within(dialog).getByText(/2 cards are unfinished/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "leave them here" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "move them to Second Brew" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "release them" })).toBeInTheDocument();

    // Backing out changes nothing at all.
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    expect(within(dialog).queryByText(/unfinished/)).toBeNull();
  });
});

describe("the project menu", () => {
  it("is a switcher, with settings behind one entry rather than a row of links", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    const menu = screen.getByRole("menu", { name: "Projects" });

    expect(within(menu).getByRole("menuitem", { name: /New project/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Project settings/ })).toBeInTheDocument();
    // The configuration links that used to pile up here are gone.
    expect(within(menu).queryByText("edit categories")).toBeNull();
    expect(within(menu).queryByText("rename project")).toBeNull();
    expect(within(menu).queryByText("archive project")).toBeNull();
  });

  it("opens settings showing the chapters gate and what it holds", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));

    const dialog = await screen.findByRole("dialog", { name: "Wizard Simulator" });
    expect(within(dialog).getByRole("checkbox", { name: /chapters/i })).toBeChecked();
    expect(within(dialog).getByText(/Open: First Brew/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 chapters/)).toBeInTheDocument();
  });
});
