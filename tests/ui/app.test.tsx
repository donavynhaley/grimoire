// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { AuditEvent, Page } from "../../shared/types";
import { boardFixture, ideaFixture } from "../fixtures/board";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function authenticatedFetch(board = boardFixture()) {
  return vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => response({ status: "authenticated", user: board.currentUser }))
    .mockImplementationOnce(() => response(board));
}

/**
 * Installs a fetch mock that answers history lookups itself.
 *
 * Page and project history load lazily whenever a dialog opens, so letting those
 * requests reach the ordered mock would shift every queued response by one.
 */
function stubFetch(
  mock: typeof fetch,
  activity: unknown = { events: [], hasMore: false },
  awayValue: unknown = { since: 0, latest: 0, total: 0, events: [] },
) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.startsWith("/api/activity")) return response(activity);
    // The away lookup and cursor advance fire on every load; answering them here
    // keeps the ordered mock aligned with the responses each test actually queues.
    if (url.startsWith("/api/away")) return response(awayValue);
    if (url.startsWith("/api/seen")) return response({ ok: true });
    return mock(input, init);
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? `${input.pathname}${input.search}` : input.url;
}

async function openWorkPage(page: Page) {
  if (page.status === "backlog") {
    await userEvent.click(await screen.findByRole("button", { name: /open backlog/i }));
  }
  await userEvent.click(await screen.findByText(page.title, { exact: true }));
  await screen.findByRole("dialog", { name: "Edit page" });
}

describe("Grimoire board", () => {
  it("refreshes the board when another browser changes work", async () => {
    const initial = boardFixture();
    const livePage = {
      ...initial.pages[0],
      id: "00000000-0000-4000-8000-000000000035",
      title: "Live page from Maren",
    };
    const updated = { ...initial, pages: [livePage, ...initial.pages] };
    let workspaceListener: ((event: Event) => void) | null = null;
    class FakeEventSource {
      close = vi.fn();
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        if (type === "workspace") workspaceListener = listener;
      }
      removeEventListener = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    expect(await screen.findByRole("button", { name: /open backlog/i })).toHaveTextContent("1");
    // The stream is opened by an effect, so the board can be on screen a tick before
    // anything is listening. Firing early made this test flaky.
    await waitFor(() => expect(workspaceListener).not.toBeNull());

    workspaceListener!(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) }));

    await waitFor(() => expect(screen.getByRole("button", { name: /open backlog/i })).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: /open backlog/i }));
    expect(await screen.findByText(livePage.title)).toBeInTheDocument();
  });

  it("prefills the default owner email during first-run setup", async () => {
    stubFetch(vi.fn<typeof fetch>().mockImplementationOnce(() => response({ status: "setup_required" })));

    render(<App />);

    expect(await screen.findByLabelText("Email")).toHaveValue("owner@example.com");
  });

  it("lands on a compact active deck while keeping backlog work out of sight", async () => {
    const fetchMock = authenticatedFetch();
    stubFetch(fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Wizard Simulator" })).toBeInTheDocument();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
      "Up Next",
      "In progress",
      "Review",
      "Done",
    ]);
    expect(screen.getByText("Model the potion workbench")).toBeInTheDocument();
    expect(screen.queryByText("Make the tower door remember Maren")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open backlog/i })).toHaveTextContent("Backlog");
    expect(screen.getByRole("button", { name: /open backlog/i })).toHaveTextContent("1");
    expect(screen.getByText("Maren")).toBeInTheDocument();
    const capture = screen.getByLabelText("Capture work page");
    expect(capture).toHaveFocus();
    expect(capture.closest("form")).toHaveClass("workspace-capture");
    expect(screen.queryByText("one board, one source of truth", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/design pillar/i)).not.toBeInTheDocument();
  });

  it("places the Work and Ideas switcher beside the product identity", async () => {
    const fetchMock = authenticatedFetch();
    stubFetch(fetchMock);

    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Project spaces" });
    expect(navigation.parentElement).toHaveClass("brand-lockup");
    expect(screen.getByRole("heading", { name: "Wizard Simulator" }).closest(".board-project")).not.toBeNull();
  });

  it("switches between Work and Ideas with 1 and 2 from an empty capture field", async () => {
    const initial = boardFixture();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(ideaFixture()));
    stubFetch(fetchMock);

    render(<App />);
    expect(await screen.findByLabelText("Capture work page")).toHaveFocus();

    await userEvent.keyboard("2");
    expect(await screen.findByRole("heading", { name: "Idea garden" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture an idea")).toHaveFocus();
    expect(window.location.search).toContain("view=ideas");

    await userEvent.keyboard("1");
    expect(screen.getByRole("region", { name: "Up Next" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture work page")).toHaveFocus();
    expect(window.location.search).not.toContain("view=ideas");

    await userEvent.type(screen.getByLabelText("Capture work page"), "room 2");
    expect(screen.getByLabelText("Capture work page")).toHaveValue("room 2");
    await userEvent.clear(screen.getByLabelText("Capture work page"));
    await userEvent.type(screen.getByLabelText("Capture work page"), "broom polish");
    expect(screen.getByLabelText("Capture work page")).toHaveValue("broom polish");
    expect(screen.queryByRole("dialog", { name: "Backlog" })).not.toBeInTheDocument();
  });

  it("captures a thought directly as a backlog page", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0],
      id: "00000000-0000-4000-8000-000000000030",
      title: "Let the broom resent being used as a weapon",
    };
    const updated = { ...initial, pages: [created, ...initial.pages] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: /open backlog/i })).toHaveTextContent("2");
    expect(screen.queryByText(created.title)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"status":"backlog"') }),
    );
  });

  it("keeps the backlog open and preserves its filters while moving several pages to Up Next", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const moved = { ...page, status: "ready" as const, position: 0 };
    const updated = { ...initial, pages: [moved, initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: moved }))
      .mockImplementationOnce(() => response(updated))
      .mockImplementationOnce(() => response({ page }))
      .mockImplementationOnce(() => response(initial));
    stubFetch(fetchMock);

    render(<App />);
    await screen.findByRole("button", { name: /open backlog/i });
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("b");

    expect(screen.getByRole("dialog", { name: "Backlog" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search backlog" });
    expect(search).toHaveFocus();
    await userEvent.type(search, "tower door");
    expect(screen.getByText(page.title)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Move ${page.title} to Up Next` }));

    const backlog = await screen.findByRole("dialog", { name: "Backlog" });
    expect(backlog).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search backlog" })).toHaveValue("tower door");
    await waitFor(() => expect(within(backlog).queryByText(page.title)).not.toBeInTheDocument());
    expect(screen.getByText(`Moved ${page.title} to Up Next`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/pages/${page.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "ready", position: 0 }) }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Undo move to Up Next" }));
    expect(await within(backlog).findByText(page.title)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/pages/${page.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "backlog", position: page.position }) }),
    );
  });

  it("configures a capture with compact buttons and restores the last settings", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0],
      id: "00000000-0000-4000-8000-000000000029",
      title: "Build the spell loadout",
      category: "code" as const,
      assigneeId: initial.members[1].id,
      assigneeName: initial.members[1].name,
      status: "ready" as const,
      position: 0,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    expect(screen.queryByRole("button", { name: "Choose category" })).not.toBeInTheDocument();
    await userEvent.type(input, created.title);

    await userEvent.click(screen.getByRole("button", { name: "Choose category" }));
    await userEvent.click(screen.getByRole("option", { name: "Code" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose assignee" }));
    await userEvent.click(screen.getByRole("option", { name: "Maren" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose column" }));
    await userEvent.click(screen.getByRole("option", { name: "Up Next" }));
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(input).toHaveValue(""));
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: /reuse code, maren, up next/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: created.title,
          category: "code",
          chapter: null,
          assigneeId: initial.members[1].id,
          status: "ready",
        }),
      }),
    );

    await userEvent.type(input, "Wire the spellbook tabs");
    await userEvent.click(screen.getByRole("button", { name: /reuse code, maren, up next/i }));
    expect(screen.getByRole("button", { name: "Category: Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assignee: Maren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Column: Up Next" })).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("uses inline commands to configure capture without adding them to the page title", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0],
      id: "00000000-0000-4000-8000-000000000030",
      title: "Polish targeting reticle",
      category: "ui" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
      status: "in_progress" as const,
      position: 1,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, `${created.title} #u`);
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, " @don");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, " /in");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: created.title,
          category: "ui",
          chapter: null,
          assigneeId: initial.currentUser.id,
          status: "in_progress",
        }),
      }),
    ));
  });

  it("moves a page by dropping it into another column", async () => {
    const initial = boardFixture();
    const page = initial.pages[1];
    const moved = { ...page, status: "ready" as const, position: 0 };
    const updated = { ...initial, pages: [initial.pages[0], moved] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: moved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const pageTitle = await screen.findByText(page.title);
    const column = screen.getByRole("region", { name: "Up Next" });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => page.id), effectAllowed: "move" };
    fireEvent.dragStart(pageTitle.closest("article")!, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "ready", position: 0 }),
        }),
      ),
    );
  });

  it("shows a live placeholder and drops a page between two pages at the pointer position", async () => {
    const initial = boardFixture();
    const [backlogPage, progressPage] = initial.pages;
    const readyA = {
      ...progressPage,
      id: "00000000-0000-4000-8000-000000000031",
      title: "Ready page A",
      status: "ready" as const,
      position: 0,
      assigneeId: null,
      assigneeName: null,
    };
    const readyB = { ...readyA, id: "00000000-0000-4000-8000-000000000032", title: "Ready page B", position: 1 };
    initial.pages = [backlogPage, progressPage, readyA, readyB];
    const moved = { ...progressPage, status: "ready" as const, position: 1 };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: moved }))
      .mockImplementationOnce(() => response({ ...initial, pages: [backlogPage, readyA, moved, readyB] }));
    stubFetch(fetchMock);

    render(<App />);
    const dragged = (await screen.findByText(progressPage.title)).closest("article")!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => progressPage.id), effectAllowed: "move" };
    fireEvent.dragStart(dragged, { dataTransfer });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(dragged).toHaveClass("drag-hidden");

    const column = screen.getByRole("region", { name: "Up Next" });
    const [nodeA, nodeB] = Array.from(column.querySelectorAll("article.board-page"));
    vi.spyOn(nodeA, "getBoundingClientRect").mockReturnValue({ top: 0, height: 50 } as DOMRect);
    vi.spyOn(nodeB, "getBoundingClientRect").mockReturnValue({ top: 50, height: 50 } as DOMRect);
    const dragOverEvent = createEvent.dragOver(column, { dataTransfer });
    Object.defineProperty(dragOverEvent, "clientY", { value: 60 });
    fireEvent(column, dragOverEvent);

    const placeholder = column.querySelector(".drop-placeholder");
    expect(placeholder).not.toBeNull();
    expect(placeholder!.nextElementSibling).toBe(nodeB);

    fireEvent.drop(column, { dataTransfer });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${progressPage.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "ready", position: 1 }),
        }),
      ),
    );
  });

  it("drags an inbox idea into the parked list", async () => {
    const initial = boardFixture();
    const ideas = ideaFixture();
    const inboxIdea = ideas.ideas[1];
    const parkedIdea = { ...inboxIdea, state: "parked" as const, position: 1 };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response(ideas))
      .mockImplementationOnce(() => response({ idea: parkedIdea }))
      .mockImplementationOnce(() => response({ ...ideas, ideas: [ideas.ideas[0], parkedIdea, ideas.ideas[2]] }));
    stubFetch(fetchMock);

    render(<App />);
    await screen.findByLabelText("Capture work page");
    await userEvent.keyboard("2");
    const dragged = (await screen.findByText(inboxIdea.title)).closest("article")!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => inboxIdea.id), effectAllowed: "move" };
    fireEvent.dragStart(dragged, { dataTransfer });
    const parked = screen.getByRole("region", { name: "Parked ideas" });
    fireEvent.dragOver(parked, { dataTransfer });
    fireEvent.drop(parked, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/ideas/${inboxIdea.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ state: "parked" }),
        }),
      ),
    );
  });

  it("lets filtered active work be dropped back into the backlog", async () => {
    const initial = boardFixture();
    const page = initial.pages[1];
    const moved = { ...page, status: "backlog" as const, position: 1 };
    const updated = { ...initial, pages: [initial.pages[0], moved] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: moved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Filter by Maren" }));
    const pageTitle = screen.getByText(page.title);
    const backlog = screen.getByRole("button", { name: /open backlog/i });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => page.id), effectAllowed: "move" };
    fireEvent.dragStart(pageTitle.closest("article")!, { dataTransfer });
    fireEvent.dragOver(backlog, { dataTransfer });
    fireEvent.drop(backlog, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "backlog", position: 1 }),
        }),
      ),
    );
  });

  it("shows only the ten most recently completed pages and keeps all work in history", async () => {
    const initial = boardFixture();
    const completed = Array.from({ length: 14 }, (_, index) => ({
      ...initial.pages[0],
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      title: `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const workspace = { ...initial, pages: [initial.pages[0], initial.pages[1], ...completed] };
    const reopened = { ...completed[0], status: "ready" as const, position: 0, completedAt: null };
    const afterReopen = {
      ...workspace,
      pages: [...workspace.pages.filter((page) => page.id !== reopened.id), reopened],
    };
    const fetchMock = authenticatedFetch(workspace)
      .mockImplementationOnce(() => response({ page: reopened }))
      .mockImplementationOnce(() => response(afterReopen));
    stubFetch(fetchMock);

    render(<App />);
    const done = await screen.findByRole("region", { name: "Done" });

    expect(done).toHaveTextContent("10 of 14");
    expect(done).toHaveTextContent("Completed spell 14");
    expect(screen.queryByText("Completed spell 1", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /search all completed work/i }));

    const history = screen.getByRole("dialog", { name: "Completed work" });
    expect(history).toHaveTextContent("Completed spell 1");
    expect(history).toHaveTextContent("Completed spell 14");
    expect(screen.getByRole("searchbox", { name: "Search completed work" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Move Completed spell 1 to Up Next" }));

    expect(await screen.findByRole("region", { name: "Up Next" })).toHaveTextContent("Completed spell 1");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/pages/${reopened.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "ready", position: 0 }) }),
    );
  });

  it("reads like an ordinary column until completed work outgrows ten pages", async () => {
    const initial = boardFixture();
    const completed = Array.from({ length: 10 }, (_, index) => ({
      ...initial.pages[0],
      id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
      title: `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    stubFetch(authenticatedFetch({ ...initial, pages: [initial.pages[0], initial.pages[1], ...completed] }));

    render(<App />);
    const done = await screen.findByRole("region", { name: "Done" });

    expect(done).toHaveTextContent("Completed spell 1");
    expect(done).toHaveTextContent("Completed spell 10");
    expect(done).not.toHaveTextContent("of 10");
    expect(screen.queryByRole("button", { name: /search all completed work/i })).not.toBeInTheDocument();
  });

  it("lets board filters reach completed work buried past the visible ten", async () => {
    const initial = boardFixture();
    const completed = Array.from({ length: 14 }, (_, index) => ({
      ...initial.pages[0],
      id: `00000000-0000-4000-8000-${String(index + 400).padStart(12, "0")}`,
      title: index === 0 ? "Ancient sealed vault" : `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    stubFetch(authenticatedFetch({ ...initial, pages: [initial.pages[0], initial.pages[1], ...completed] }));

    render(<App />);
    const done = await screen.findByRole("region", { name: "Done" });

    // Oldest of fourteen, so the ten-page column has no room for it.
    expect(done).not.toHaveTextContent("Ancient sealed vault");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search pages" }), "Ancient sealed");

    expect(done).toHaveTextContent("Ancient sealed vault");
  });

  it("edits a page with member buttons instead of dropdowns", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const assigned = { ...page, assigneeId: initial.members[1].id, assigneeName: "Maren" };
    const updated = { ...initial, pages: [assigned, initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: assigned }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkPage(page);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /assign maren/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ assigneeId: initial.members[1].id }) }),
      ),
    );
  });

  it("shows page categories and links blockers without a dropdown", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const categorized = { ...page, category: "code" as const };
    const afterCategory = { ...initial, pages: [categorized, initial.pages[1]] };
    const blocked = { ...categorized, blockedBy: [initial.pages[1].id] };
    const afterBlocker = { ...initial, pages: [blocked, initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: categorized }))
      .mockImplementationOnce(() => response(afterCategory))
      .mockImplementationOnce(() => response({ page: blocked }))
      .mockImplementationOnce(() => response(afterBlocker));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkPage(page);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // Category is the one attribute folded to its current value, so it is read before it is
    // changed - and opening it still reveals plain buttons rather than a menu.
    const rail = screen.getByRole("dialog", { name: "Edit page" }).querySelector(".page-rail")!;
    expect(within(rail as HTMLElement).getByText("Narrative")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change category" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Categorize as Code" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ category: "code" }) }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Add blocking page" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a blocking page" }), "potion");
    await userEvent.click(screen.getByRole("button", { name: `Blocked by ${initial.pages[1].title}` }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ blockedBy: [initial.pages[1].id] }),
        }),
      ),
    );
    expect((await screen.findAllByText(initial.pages[1].title)).length).toBeGreaterThan(0);
  });

  it("opens a page straight from a shared link", async () => {
    const initial = boardFixture();
    const page = initial.pages[1];
    window.history.replaceState({}, "", `/?page=${page.id}`);
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await screen.findByRole("dialog", { name: "Edit page" });
    expect(screen.getByLabelText("Title")).toHaveValue(page.title);
  });

  it("keeps the open page in the URL and clears it on close", async () => {
    const initial = boardFixture();
    const page = initial.pages[1];
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await openWorkPage(page);
    expect(window.location.search).toContain(`page=${page.id}`);

    await userEvent.click(screen.getByRole("button", { name: "Close page" }));
    await waitFor(() => expect(window.location.search).not.toContain("page="));
  });

  it("drops a shared link to a page that no longer exists", async () => {
    const initial = boardFixture();
    window.history.replaceState({}, "", "/?page=00000000-0000-4000-8000-00000000dead");
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await screen.findByText(initial.pages[1].title);
    expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("page="));
  });

  it("opens an idea straight from a shared link in the ideas view", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const idea = ideaWorkspace.ideas[0];
    window.history.replaceState({}, "", `/?view=ideas&idea=${idea.id}`);
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(ideaWorkspace));
    stubFetch(fetchMock);

    render(<App />);
    await screen.findByRole("dialog", { name: "Edit idea" });
    expect(screen.getByLabelText("Idea title")).toHaveValue(idea.title);
    expect(window.location.search).toContain(`idea=${idea.id}`);
  });

  it("automatically saves title and notes without a save button", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const note = "Keep the memory readable without subtitles.";
    const saved = { ...page, description: note };
    const updated = { ...initial, pages: [saved, initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: saved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkPage(page);

    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), note);

    // Only the rewritten field travels, and it carries the value it is replacing, so an
    // untouched title can never overwrite a teammate's edit to it.
    await waitFor(
      () =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/pages/${page.id}`,
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ description: note, expectedDescription: page.description }),
          }),
        ),
      { timeout: 2_000 },
    );
  });

  it("offers to undo an archived page", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const archived = { ...initial, pages: [initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ ok: true }))
      .mockImplementationOnce(() => response(archived))
      .mockImplementationOnce(() => response({ page }))
      .mockImplementationOnce(() => response(initial));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkPage(page);
    await userEvent.click(screen.getByRole("button", { name: "archive page" }));
    await userEvent.click(screen.getByRole("button", { name: "yes, archive" }));

    expect(await screen.findByText(`Archived ${page.title}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo archive" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}/restore`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /open backlog/i }));
    expect(await screen.findByText(page.title)).toBeInTheDocument();
  });

  it("offers to undo an idea promotion", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const idea = ideaWorkspace.ideas[0];
    const promotedPage = {
      ...initial.pages[0],
      id: "00000000-0000-4000-8000-000000000050",
      title: idea.title,
      description: idea.description,
    };
    const promotedIdeas = { ...ideaWorkspace, ideas: ideaWorkspace.ideas.filter((candidate) => candidate.id !== idea.id) };
    const promotedBoard = { ...initial, pages: [...initial.pages, promotedPage] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response(ideaWorkspace))
      .mockImplementationOnce(() => response({ page: promotedPage }, 201))
      .mockImplementationOnce(() => response(promotedIdeas))
      .mockImplementationOnce(() => response(promotedBoard))
      .mockImplementationOnce(() => response({ idea }))
      .mockImplementationOnce(() => response(initial))
      .mockImplementationOnce(() => response(ideaWorkspace));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "ideas" }));
    await userEvent.click(await screen.findByRole("button", { name: `Open idea ${idea.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "make work page" }));
    await userEvent.click(screen.getByRole("button", { name: "yes, make page" }));

    expect(await screen.findByText(`Promoted ${idea.title}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo promotion" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/ideas/${idea.id}/promotion`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(await screen.findByRole("button", { name: `Open idea ${idea.title}` })).toBeInTheDocument();
  });

  it("flushes pending text when the page is closed", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const title = "Make the tower door remember both wizards";
    const saved = { ...page, title };
    const updated = { ...initial, pages: [saved, initial.pages[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ page: saved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkPage(page);
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), title);
    await userEvent.click(screen.getByRole("button", { name: "Close page" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/pages/${page.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title, expectedTitle: page.title }),
      }),
    );
  });

  it("changes the signed-in user's password from account settings", async () => {
    const initial = boardFixture();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response({ ok: true }));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /open account settings/i }));

    expect(screen.getByRole("heading", { name: "Account settings" })).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Current password"), "correct horse wizard tower");
    await userEvent.type(screen.getByLabelText(/^New password/i), "an even newer secure wizard password");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "an even newer secure wizard password");
    await userEvent.click(screen.getByRole("button", { name: "change password" }));

    await waitFor(() => expect(screen.getByText("password changed")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          currentPassword: "correct horse wizard tower",
          newPassword: "an even newer secure wizard password",
        }),
      }),
    );
  });

  it("changes the display name from account settings and shows it everywhere", async () => {
    const initial = boardFixture();
    const renamed = { ...initial.currentUser, name: "Dono" };
    const updated = {
      ...initial,
      currentUser: renamed,
      members: initial.members.map((member) => (member.id === renamed.id ? { ...member, name: "Dono" } : member)),
    };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ user: renamed }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /open account settings/i }));

    const field = screen.getByLabelText("Display name");
    await userEvent.clear(field);
    await userEvent.type(field, "Dono");
    await userEvent.click(screen.getByRole("button", { name: "save name" }));

    await waitFor(() => expect(screen.getByText("name updated")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/name",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Dono" }) }),
    );
    expect(await screen.findByRole("button", { name: /open account settings for Dono/i })).toBeInTheDocument();
  });

  it("lets the owner remove a member from the team dialog", async () => {
    const initial = boardFixture();
    const removedMember = initial.members[1];
    const updated = {
      ...initial,
      members: initial.members.filter((member) => member.id !== removedMember.id),
      pages: initial.pages.map((page) => page.assigneeId === removedMember.id
        ? { ...page, assigneeId: null, assigneeName: null }
        : page),
    };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ ok: true }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "team" }));

    expect(screen.queryByRole("button", { name: `Remove ${initial.currentUser.name}` })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Remove ${removedMember.name}` }));
    await userEvent.click(screen.getByRole("button", { name: `Confirm remove ${removedMember.name}` }));

    await waitFor(() => expect(screen.queryByText(removedMember.email)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/members/${removedMember.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("explains that only the newest invite works for one person", async () => {
    const initial = boardFixture();
    const fetchMock = authenticatedFetch(initial);
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "team" }));

    expect(screen.getByText(/one person can use this link/i)).toBeInTheDocument();
    expect(screen.getByText(/creating another revokes this one/i)).toBeInTheDocument();
  });

  it("keeps ideas in a separate ranked garden", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(ideaWorkspace));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "ideas" }));

    expect(await screen.findByRole("heading", { name: "Idea garden" })).toBeInTheDocument();
    const capture = screen.getByLabelText("Capture an idea");
    expect(capture).toHaveFocus();
    expect(capture.closest("form")).toHaveClass("workspace-capture");
    expect(screen.queryByText("save possibility without growing the backlog", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Shortlist" })).toHaveTextContent(
      "Spells are assembled from drawn rune sequences",
    );
    expect(screen.getByRole("region", { name: "Idea inbox" })).toHaveTextContent(
      "Familiars learn recurring player habits",
    );
    expect(screen.queryByText("Model the potion workbench")).not.toBeInTheDocument();
    expect(window.location.search).toContain("view=ideas");
  });

  it("captures and shortlists an idea without creating a work page", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const captured = {
      ...ideaWorkspace.ideas[1],
      id: "00000000-0000-4000-8000-000000000043",
      title: "Let failed potions become useful materials",
    };
    const afterCapture = { ...ideaWorkspace, ideas: [...ideaWorkspace.ideas, captured] };
    const shortlisted = { ...captured, state: "shortlist" as const, position: 1 };
    const afterShortlist = {
      ...ideaWorkspace,
      ideas: [...ideaWorkspace.ideas, shortlisted].filter((idea) => idea.id !== captured.id || idea === shortlisted),
    };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response(ideaWorkspace))
      .mockImplementationOnce(() => response({ idea: captured }, 201))
      .mockImplementationOnce(() => response(afterCapture))
      .mockImplementationOnce(() => response({ idea: shortlisted }))
      .mockImplementationOnce(() => response(afterShortlist));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "ideas" }));
    await userEvent.type(await screen.findByLabelText("Capture an idea"), captured.title);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: `Shortlist ${captured.title}` }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ideas",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: captured.title }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/ideas/${captured.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "shortlist", position: 1 }) }),
    );
  });

  it("filters work with search and person chips, including the current user", async () => {
    const initial = boardFixture();
    const myPage = {
      ...initial.pages[0],
      status: "ready" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
    };
    const workspace = { ...initial, pages: [myPage, initial.pages[1]] };
    const fetchMock = authenticatedFetch(workspace);
    stubFetch(fetchMock);

    render(<App />);
    expect(await screen.findByRole("searchbox", { name: "Search pages" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "all work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "active" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search pages" }), "tower door");
    expect(screen.getByText("Make the tower door remember Maren")).toBeInTheDocument();
    expect(screen.queryByText("Model the potion workbench")).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "Search pages" }));
    const myWork = screen.getByRole("button", { name: "Filter to my work" });
    expect(myWork).toHaveTextContent("me");
    await userEvent.click(myWork);
    expect(screen.getByText("Make the tower door remember Maren")).toBeInTheDocument();
    expect(screen.queryByText("Model the potion workbench")).not.toBeInTheDocument();
    expect(window.location.search).toContain(`people=${initial.currentUser.id}`);

    await userEvent.click(myWork);
    await userEvent.click(screen.getByRole("button", { name: "Filter by Maren" }));
    expect(screen.queryByText("Make the tower door remember Maren")).not.toBeInTheDocument();
    expect(screen.getByText("Model the potion workbench")).toBeInTheDocument();
    expect(window.location.search).toContain(`people=${initial.members[1].id}`);
  });

  it("reads the project history as sentences and opens the page behind an entry", async () => {
    const initial = boardFixture();
    const page = initial.pages.find((candidate) => candidate.status === "in_progress")!;
    const fetchMock = authenticatedFetch(initial);
    stubFetch(fetchMock, {
      hasMore: false,
      events: [
        auditFixture({
          action: "moved",
          entityId: page.id,
          entityTitle: page.title,
          changes: [{ field: "column", from: "Up Next", to: "In progress" }],
        }),
        auditFixture({
          action: "joined",
          actorName: "Maren",
          actorId: initial.members[1].id,
          entityType: "member",
          entityTitle: "Maren",
          id: "audit-2",
        }),
      ],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "activity" }));

    const dialog = await screen.findByRole("dialog", { name: "Activity" });
    expect(within(dialog).getByText("moved page", { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText("column: Up Next → In progress")).toBeInTheDocument();
    expect(within(dialog).getByText("joined the project", { exact: false })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: `Open ${page.title}` }));
    expect(await screen.findByRole("dialog", { name: "Edit page" })).toBeInTheDocument();
  });

  it("shows recent changes inside the page it opens", async () => {
    const initial = boardFixture();
    const page = initial.pages.find((candidate) => candidate.status === "in_progress")!;
    stubFetch(authenticatedFetch(initial), {
      hasMore: false,
      events: [auditFixture({
        action: "updated",
        entityId: page.id,
        entityTitle: page.title,
        changes: [{ field: "assignee", from: "unassigned", to: "Maren" }],
      })],
    });

    render(<App />);
    await openWorkPage(page);

    const dialog = screen.getByRole("dialog", { name: "Edit page" });
    expect(within(dialog).getByText("History")).toBeInTheDocument();
    expect(within(dialog).getByText("assignee: unassigned → Maren")).toBeInTheDocument();
  });

  it("marks connected teammates as online", async () => {
    const initial = boardFixture();
    let presenceListener: ((event: Event) => void) | null = null;
    class FakeEventSource {
      close = vi.fn();
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        if (type === "presence") presenceListener = listener;
      }
      removeEventListener = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    const maren = await screen.findByRole("button", { name: "Filter by Maren" });
    expect(maren.querySelector(".avatar")).not.toHaveClass("online");

    // The stream is opened by an effect, which can flush after the board has painted. Firing
    // presence before the listener exists throws, so wait for the subscription itself rather
    // than treating the drawn board as proof of it.
    await waitFor(() => expect(presenceListener).not.toBeNull());

    act(() => {
      presenceListener!(new MessageEvent("presence", {
        data: JSON.stringify({ online: [initial.members[1].id] }),
      }));
    });

    await waitFor(() => expect(maren.querySelector(".avatar")).toHaveClass("online"));
    expect(screen.getAllByTitle("Maren (online)").length).toBeGreaterThan(0);
  });
});

function auditFixture(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sequence: 1,
    id: "audit-1",
    actorId: "00000000-0000-4000-8000-000000000010",
    actorName: "Donavyn",
    agentName: null,
    entityType: "page",
    entityId: null,
    entityTitle: "a page",
    action: "updated",
    changes: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
