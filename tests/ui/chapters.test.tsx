// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, Page, Chapter } from "../../shared/types";
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
  carriedPages: null,
  carriedEstimate: null,
  carriedTo: null,
  deliveredPages: null,
  deliveredEstimate: null,
    ...overrides,
  };
}

function page(overrides: Partial<Page>): Page {
  const base = boardFixture().pages[1];
  return { ...base, ...overrides };
}

/** A board with chapters on, one open chapter, and pages on both sides of it. */
function chapteredBoard(): BoardWorkspace {
  const board = boardFixture();
  return {
    ...board,
    project: { ...board.project, chaptersEnabled: true },
    velocity: [],
  chapters: [chapter(), chapter({ slug: "second-brew", name: "Second Brew", state: "planned", startsOn: null, endsOn: null })],
    pages: [
      page({ id: "page-in", title: "Inside the chapter", chapter: "first-brew", status: "ready", position: 0 }),
      page({ id: "page-out", title: "Outside the chapter", chapter: null, status: "ready", position: 1 }),
      page({ id: "page-backlog", title: "Reserved for later", chapter: "first-brew", status: "backlog", position: 0 }),
      page({ id: "page-unplaced", title: "Waiting to be placed", chapter: null, status: "backlog", position: 1 }),
    ],
  };
}

/** The same board with a finished chapter behind the open one. */
function withClosedChapter(): BoardWorkspace {
  const board = chapteredBoard();
  return {
    ...board,
    chapters: [
      ...board.chapters,
      chapter({ slug: "old-brew", name: "Old Brew", state: "closed", closedAt: "2026-08-12T00:00:00.000Z" }),
    ],
  };
}

/** Mounts the app over a board, recording every write it makes. */
function mountWith(board: BoardWorkspace) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response({ ok: true });
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/seen")) return response({ ok: true });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
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

    // The chapter's own page is on the board; the unplaced one is filtered out.
    expect(await screen.findByText("Inside the chapter")).toBeInTheDocument();
    expect(screen.queryByText("Outside the chapter")).toBeNull();
  });

  it("names the chapter and its dates instead of a bare page count", async () => {
    mountWith(chapteredBoard());

    expect(await screen.findByRole("heading", { name: "First Brew", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Get one full potion loop playable end to end\./)).toBeInTheDocument();
  });

  it("reports the chapter's backlog reserve in the chapter's own line", async () => {
    mountWith(chapteredBoard());

    // The reserve belongs in the sentence about this chapter. Repeating it under the filters
    // put a second count beside the Backlog pill that already carries one.
    const line = await screen.findByText(/active page/);
    expect(line).toHaveTextContent("1 in backlog");
    expect(screen.queryByText("1 in Backlog")).toBeNull();
  });

  it("widens back to every page through All work, and records it in the URL", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /All work/ }));

    expect(await screen.findByText("Outside the chapter")).toBeInTheDocument();
    expect(screen.getByText("Inside the chapter")).toBeInTheDocument();
    // All work is the absence of a filter, so it leaves no chapter in the address bar.
    await waitFor(() => expect(new URLSearchParams(location.search).get("chapter")).toBeNull());
  });

  it("filters to pages nobody has placed", async () => {
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

  it("folds the finished chapters away and opens them on request", async () => {
    const user = userEvent.setup();
    mountWith(withClosedChapter());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));

    // The live chapters are in reach; the finished one is behind its own count.
    expect(screen.getByRole("menuitem", { name: /Second Brew/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Old Brew/ })).toBeNull();

    const fold = screen.getByRole("button", { name: /earlier/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("1");

    await user.click(fold);
    expect(screen.getByRole("menuitem", { name: /Old Brew/ })).toBeInTheDocument();
  });

  it("folds them back once the picker has been closed again", async () => {
    const user = userEvent.setup();
    mountWith(withClosedChapter());

    const trigger = await screen.findByRole("button", { name: /Filter by chapter/ });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: /earlier/ }));
    expect(screen.getByRole("menuitem", { name: /Old Brew/ })).toBeInTheDocument();

    // Reaching for one old chapter is not a standing instruction to keep showing them all.
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("menuitem", { name: /Old Brew/ })).toBeNull();
  });

  it("shows the finished chapters on sight when the board is filtered to one", async () => {
    window.history.replaceState({}, "", "/?chapter=old-brew");
    const user = userEvent.setup();
    mountWith(withClosedChapter());

    // Otherwise the row the board is currently narrowed to would be hidden inside the fold.
    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    expect(screen.getByRole("button", { name: /earlier/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /Old Brew/ })).toHaveAttribute("aria-current", "true");
  });

  it("keeps the chapter filter alongside a people filter", async () => {
    const user = userEvent.setup();
    const board = chapteredBoard();
    mountWith(board);

    await screen.findByText("Inside the chapter");
    await user.click(screen.getByRole("button", { name: "unassigned" }));

    // Both filters apply: the chapter's page is assigned, so nothing survives.
    await waitFor(() => expect(screen.queryByText("Inside the chapter")).toBeNull());
    expect(new URLSearchParams(location.search).get("chapter")).toBe("first-brew");
    expect(new URLSearchParams(location.search).get("people")).toBe("unassigned");
  });
});

describe("choosing which chapter is current", () => {
  it("promotes a dateless chapter from the picker, closing the open one first", async () => {
    const user = userEvent.setup();
    const board = chapteredBoard();
    const patched: Array<{ slug: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
      if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
      if (url.startsWith("/api/seen")) return response({ ok: true });
      if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
      if (url.startsWith("/api/chapters/") && init?.method === "PATCH") {
        patched.push({ slug: url.split("/").pop()!, body: JSON.parse(String(init.body)) });
        return response({ chapter: board.chapters[1] });
      }
      return response(board);
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    // Second Brew has no dates, so nothing about it implies it should be current.
    await user.click(screen.getByRole("button", { name: "Make Second Brew the current chapter" }));

    // One chapter is open at a time, so this is two writes that read as a single decision.
    await waitFor(() => expect(patched).toEqual([
      { slug: "first-brew", body: { state: "closed" } },
      { slug: "second-brew", body: { state: "open" } },
    ]));
  });

  it("offers no promotion for the chapter that is already current", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));

    expect(screen.queryByRole("button", { name: "Make First Brew the current chapter" })).toBeNull();
    expect(screen.getByRole("button", { name: "Make Second Brew the current chapter" })).toBeInTheDocument();
  });
});

describe("pulling from the backlog", () => {
  it("offers the viewed chapter on every row and leaves the page in the Backlog", async () => {
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
        return response({ page: board.pages[0] });
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

  it("shows a page already in the chapter as a state rather than an action", async () => {
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
    // The board's manage door opens the one settings surface, landed on its Chapters section.
    const dialog = await screen.findByRole("dialog", { name: "Project settings" });
    await user.click(within(dialog).getByRole("button", { name: "close" }));

    // Two of First Brew's pages are unfinished, and every route out is a named choice.
    expect(within(dialog).getByText(/2 pages are unfinished/)).toBeInTheDocument();
    // Rolling onward leads, naming where the work would go.
    expect(within(dialog).getByRole("button", { name: "roll them into Second Brew" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "leave them here" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "release them" })).toBeInTheDocument();

    // Backing out changes nothing at all.
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    expect(within(dialog).queryByText(/unfinished/)).toBeNull();
  });

  it("rolls the work onward as one act rather than a sweep of page edits", async () => {
    const user = userEvent.setup();
    const calls = mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /Manage chapters/ }));
    const dialog = await screen.findByRole("dialog", { name: "Project settings" });
    await user.click(within(dialog).getByRole("button", { name: "close" }));
    await user.click(within(dialog).getByRole("button", { name: "roll them into Second Brew" }));

    // One request says both what happened to the chapter and what happened to its work.
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: "/api/chapters/first-brew/close",
          method: "POST",
          body: { rollover: "next" },
        }),
      ),
    );
    // And no page was edited one at a time to achieve it.
    expect(calls.filter((call) => call.url.startsWith("/api/pages/"))).toHaveLength(0);
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

  it("opens settings whose Chapters section holds the gate and what it guards", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));

    const dialog = await screen.findByRole("dialog", { name: "Project settings" });
    await user.click(within(dialog).getByRole("button", { name: "Chapters" }));
    expect(within(dialog).getByRole("checkbox", { name: /chapters/i })).toBeChecked();
    expect(within(dialog).getByText(/Open: First Brew/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 chapters/)).toBeInTheDocument();
  });

  it("keeps the open settings section across a reload by carrying it in the URL", async () => {
    const user = userEvent.setup();
    mountWith(chapteredBoard());

    await user.click(await screen.findByRole("button", { name: /Filter by chapter/ }));
    await user.click(screen.getByRole("menuitem", { name: /Manage chapters/ }));
    await screen.findByRole("dialog", { name: "Project settings" });

    expect(new URLSearchParams(location.search).get("settings")).toBe("chapters");
  });
});
