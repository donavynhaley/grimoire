// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { AuditEvent, Card } from "../../shared/types";
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
 * Card and project history load lazily whenever a dialog opens, so letting those
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

async function openWorkCard(card: Card) {
  if (card.status === "backlog") {
    await userEvent.click(await screen.findByRole("button", { name: /open backlog/i }));
  }
  await userEvent.click(await screen.findByText(card.title, { exact: true }));
  await screen.findByRole("dialog", { name: "Edit card" });
}

describe("Grimoire board", () => {
  it("refreshes the board when another browser changes work", async () => {
    const initial = boardFixture();
    const liveCard = {
      ...initial.cards[0],
      id: "00000000-0000-4000-8000-000000000035",
      title: "Live card from Maren",
    };
    const updated = { ...initial, cards: [liveCard, ...initial.cards] };
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

    workspaceListener!(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) }));

    await waitFor(() => expect(screen.getByRole("button", { name: /open backlog/i })).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: /open backlog/i }));
    expect(await screen.findByText(liveCard.title)).toBeInTheDocument();
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
    const capture = screen.getByLabelText("Capture work card");
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
    expect(await screen.findByLabelText("Capture work card")).toHaveFocus();

    await userEvent.keyboard("2");
    expect(await screen.findByRole("heading", { name: "Idea garden" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture an idea")).toHaveFocus();
    expect(window.location.search).toContain("view=ideas");

    await userEvent.keyboard("1");
    expect(screen.getByRole("region", { name: "Up Next" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture work card")).toHaveFocus();
    expect(window.location.search).not.toContain("view=ideas");

    await userEvent.type(screen.getByLabelText("Capture work card"), "room 2");
    expect(screen.getByLabelText("Capture work card")).toHaveValue("room 2");
    await userEvent.clear(screen.getByLabelText("Capture work card"));
    await userEvent.type(screen.getByLabelText("Capture work card"), "broom polish");
    expect(screen.getByLabelText("Capture work card")).toHaveValue("broom polish");
    expect(screen.queryByRole("dialog", { name: "Backlog" })).not.toBeInTheDocument();
  });

  it("captures a thought directly as a backlog card", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.cards[0],
      id: "00000000-0000-4000-8000-000000000030",
      title: "Let the broom resent being used as a weapon",
    };
    const updated = { ...initial, cards: [created, ...initial.cards] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work card");
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: /open backlog/i })).toHaveTextContent("2");
    expect(screen.queryByText(created.title)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cards",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"status":"backlog"') }),
    );
  });

  it("keeps the backlog open and preserves its filters while moving several cards to Up Next", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const moved = { ...card, status: "ready" as const, position: 0 };
    const updated = { ...initial, cards: [moved, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response(updated))
      .mockImplementationOnce(() => response({ card }))
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
    expect(screen.getByText(card.title)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Move ${card.title} to Up Next` }));

    const backlog = await screen.findByRole("dialog", { name: "Backlog" });
    expect(backlog).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search backlog" })).toHaveValue("tower door");
    await waitFor(() => expect(within(backlog).queryByText(card.title)).not.toBeInTheDocument());
    expect(screen.getByText(`Moved ${card.title} to Up Next`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "ready", position: 0 }) }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Undo move to Up Next" }));
    expect(await within(backlog).findByText(card.title)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "backlog", position: card.position }) }),
    );
  });

  it("configures a capture with compact buttons and restores the last settings", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.cards[0],
      id: "00000000-0000-4000-8000-000000000029",
      title: "Build the spell loadout",
      category: "code" as const,
      assigneeId: initial.members[1].id,
      assigneeName: initial.members[1].name,
      status: "ready" as const,
      position: 0,
    };
    const updated = { ...initial, cards: [...initial.cards, created] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work card");
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
      "/api/cards",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: created.title,
          category: "code",
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

  it("uses inline commands to configure capture without adding them to the card title", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.cards[0],
      id: "00000000-0000-4000-8000-000000000030",
      title: "Polish targeting reticle",
      category: "ui" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
      status: "in_progress" as const,
      position: 1,
    };
    const updated = { ...initial, cards: [...initial.cards, created] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: created }, 201))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const input = await screen.findByLabelText("Capture work card");
    await userEvent.type(input, `${created.title} #u`);
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, " @don");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, " /in");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/cards",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: created.title,
          category: "ui",
          assigneeId: initial.currentUser.id,
          status: "in_progress",
        }),
      }),
    ));
  });

  it("moves a card by dropping it into another column", async () => {
    const initial = boardFixture();
    const card = initial.cards[1];
    const moved = { ...card, status: "ready" as const, position: 0 };
    const updated = { ...initial, cards: [initial.cards[0], moved] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    const cardTitle = await screen.findByText(card.title);
    const column = screen.getByRole("region", { name: "Up Next" });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => card.id), effectAllowed: "move" };
    fireEvent.dragStart(cardTitle.closest("article")!, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "ready", position: 0 }),
        }),
      ),
    );
  });

  it("shows a live placeholder and drops a card between two cards at the pointer position", async () => {
    const initial = boardFixture();
    const [backlogCard, progressCard] = initial.cards;
    const readyA = {
      ...progressCard,
      id: "00000000-0000-4000-8000-000000000031",
      title: "Ready card A",
      status: "ready" as const,
      position: 0,
      assigneeId: null,
      assigneeName: null,
    };
    const readyB = { ...readyA, id: "00000000-0000-4000-8000-000000000032", title: "Ready card B", position: 1 };
    initial.cards = [backlogCard, progressCard, readyA, readyB];
    const moved = { ...progressCard, status: "ready" as const, position: 1 };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response({ ...initial, cards: [backlogCard, readyA, moved, readyB] }));
    stubFetch(fetchMock);

    render(<App />);
    const dragged = (await screen.findByText(progressCard.title)).closest("article")!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => progressCard.id), effectAllowed: "move" };
    fireEvent.dragStart(dragged, { dataTransfer });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(dragged).toHaveClass("drag-hidden");

    const column = screen.getByRole("region", { name: "Up Next" });
    const [nodeA, nodeB] = Array.from(column.querySelectorAll("article.board-card"));
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
        `/api/cards/${progressCard.id}`,
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
    await screen.findByLabelText("Capture work card");
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
    const card = initial.cards[1];
    const moved = { ...card, status: "backlog" as const, position: 1 };
    const updated = { ...initial, cards: [initial.cards[0], moved] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Filter by Maren" }));
    const cardTitle = screen.getByText(card.title);
    const backlog = screen.getByRole("button", { name: /open backlog/i });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => card.id), effectAllowed: "move" };
    fireEvent.dragStart(cardTitle.closest("article")!, { dataTransfer });
    fireEvent.dragOver(backlog, { dataTransfer });
    fireEvent.drop(backlog, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "backlog", position: 1 }),
        }),
      ),
    );
  });

  it("shows only the eight most recently completed cards and keeps all work in history", async () => {
    const initial = boardFixture();
    const completed = Array.from({ length: 10 }, (_, index) => ({
      ...initial.cards[0],
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      title: `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const workspace = { ...initial, cards: [initial.cards[0], initial.cards[1], ...completed] };
    const reopened = { ...completed[0], status: "ready" as const, position: 0, completedAt: null };
    const afterReopen = {
      ...workspace,
      cards: [...workspace.cards.filter((card) => card.id !== reopened.id), reopened],
    };
    const fetchMock = authenticatedFetch(workspace)
      .mockImplementationOnce(() => response({ card: reopened }))
      .mockImplementationOnce(() => response(afterReopen));
    stubFetch(fetchMock);

    render(<App />);
    const done = await screen.findByRole("region", { name: "Done" });

    expect(done).toHaveTextContent("8 of 10");
    expect(done).toHaveTextContent("Completed spell 10");
    expect(screen.queryByText("Completed spell 1", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open completed work history/i }));

    const history = screen.getByRole("dialog", { name: "Completed work" });
    expect(history).toHaveTextContent("Completed spell 1");
    expect(history).toHaveTextContent("Completed spell 10");
    expect(screen.getByRole("searchbox", { name: "Search completed work" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Move Completed spell 1 to Up Next" }));

    expect(await screen.findByRole("region", { name: "Up Next" })).toHaveTextContent("Completed spell 1");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/cards/${reopened.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "ready", position: 0 }) }),
    );
  });

  it("edits a card with member buttons instead of dropdowns", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const assigned = { ...card, assigneeId: initial.members[1].id, assigneeName: "Maren" };
    const updated = { ...initial, cards: [assigned, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: assigned }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkCard(card);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /assign maren/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ assigneeId: initial.members[1].id }) }),
      ),
    );
  });

  it("shows card categories and links blockers without a dropdown", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const categorized = { ...card, category: "code" as const };
    const afterCategory = { ...initial, cards: [categorized, initial.cards[1]] };
    const blocked = { ...categorized, blockedBy: [initial.cards[1].id] };
    const afterBlocker = { ...initial, cards: [blocked, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: categorized }))
      .mockImplementationOnce(() => response(afterCategory))
      .mockImplementationOnce(() => response({ card: blocked }))
      .mockImplementationOnce(() => response(afterBlocker));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkCard(card);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Categorize as Code" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ category: "code" }) }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Add blocking card" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a blocking card" }), "potion");
    await userEvent.click(screen.getByRole("button", { name: `Blocked by ${initial.cards[1].title}` }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ blockedBy: [initial.cards[1].id] }),
        }),
      ),
    );
    expect((await screen.findAllByText(initial.cards[1].title)).length).toBeGreaterThan(0);
  });

  it("opens a card straight from a shared link", async () => {
    const initial = boardFixture();
    const card = initial.cards[1];
    window.history.replaceState({}, "", `/?card=${card.id}`);
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await screen.findByRole("dialog", { name: "Edit card" });
    expect(screen.getByLabelText("Title")).toHaveValue(card.title);
  });

  it("keeps the open card in the URL and clears it on close", async () => {
    const initial = boardFixture();
    const card = initial.cards[1];
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await openWorkCard(card);
    expect(window.location.search).toContain(`card=${card.id}`);

    await userEvent.click(screen.getByRole("button", { name: "Close card" }));
    await waitFor(() => expect(window.location.search).not.toContain("card="));
  });

  it("drops a shared link to a card that no longer exists", async () => {
    const initial = boardFixture();
    window.history.replaceState({}, "", "/?card=00000000-0000-4000-8000-00000000dead");
    stubFetch(authenticatedFetch(initial));

    render(<App />);
    await screen.findByText(initial.cards[1].title);
    expect(screen.queryByRole("dialog", { name: "Edit card" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("card="));
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
    const card = initial.cards[0];
    const note = "Keep the memory readable without subtitles.";
    const saved = { ...card, description: note };
    const updated = { ...initial, cards: [saved, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: saved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkCard(card);

    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), note);

    await waitFor(
      () =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/cards/${card.id}`,
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ title: card.title, description: note }),
          }),
        ),
      { timeout: 2_000 },
    );
  });

  it("offers to undo an archived card", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const archived = { ...initial, cards: [initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ ok: true }))
      .mockImplementationOnce(() => response(archived))
      .mockImplementationOnce(() => response({ card }))
      .mockImplementationOnce(() => response(initial));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkCard(card);
    await userEvent.click(screen.getByRole("button", { name: "archive card" }));
    await userEvent.click(screen.getByRole("button", { name: "yes, archive" }));

    expect(await screen.findByText(`Archived ${card.title}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo archive" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${card.id}/restore`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /open backlog/i }));
    expect(await screen.findByText(card.title)).toBeInTheDocument();
  });

  it("offers to undo an idea promotion", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const idea = ideaWorkspace.ideas[0];
    const promotedCard = {
      ...initial.cards[0],
      id: "00000000-0000-4000-8000-000000000050",
      title: idea.title,
      description: idea.description,
    };
    const promotedIdeas = { ...ideaWorkspace, ideas: ideaWorkspace.ideas.filter((candidate) => candidate.id !== idea.id) };
    const promotedBoard = { ...initial, cards: [...initial.cards, promotedCard] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response(ideaWorkspace))
      .mockImplementationOnce(() => response({ card: promotedCard }, 201))
      .mockImplementationOnce(() => response(promotedIdeas))
      .mockImplementationOnce(() => response(promotedBoard))
      .mockImplementationOnce(() => response({ idea }))
      .mockImplementationOnce(() => response(initial))
      .mockImplementationOnce(() => response(ideaWorkspace));
    stubFetch(fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "ideas" }));
    await userEvent.click(await screen.findByRole("button", { name: `Open idea ${idea.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "make work card" }));
    await userEvent.click(screen.getByRole("button", { name: "yes, make card" }));

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

  it("flushes pending text when the card is closed", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const title = "Make the tower door remember both wizards";
    const saved = { ...card, title };
    const updated = { ...initial, cards: [saved, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: saved }))
      .mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openWorkCard(card);
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), title);
    await userEvent.click(screen.getByRole("button", { name: "Close card" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit card" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title, description: card.description }),
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

  it("lets the owner remove a member from the team dialog", async () => {
    const initial = boardFixture();
    const removedMember = initial.members[1];
    const updated = {
      ...initial,
      members: initial.members.filter((member) => member.id !== removedMember.id),
      cards: initial.cards.map((card) => card.assigneeId === removedMember.id
        ? { ...card, assigneeId: null, assigneeName: null }
        : card),
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

  it("captures and shortlists an idea without creating a work card", async () => {
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
    const myCard = {
      ...initial.cards[0],
      status: "ready" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
    };
    const workspace = { ...initial, cards: [myCard, initial.cards[1]] };
    const fetchMock = authenticatedFetch(workspace);
    stubFetch(fetchMock);

    render(<App />);
    expect(await screen.findByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "all work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "active" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search cards" }), "tower door");
    expect(screen.getByText("Make the tower door remember Maren")).toBeInTheDocument();
    expect(screen.queryByText("Model the potion workbench")).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "Search cards" }));
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

  it("reads the project history as sentences and opens the card behind an entry", async () => {
    const initial = boardFixture();
    const card = initial.cards.find((candidate) => candidate.status === "in_progress")!;
    const fetchMock = authenticatedFetch(initial);
    stubFetch(fetchMock, {
      hasMore: false,
      events: [
        auditFixture({
          action: "moved",
          entityId: card.id,
          entityTitle: card.title,
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
    expect(within(dialog).getByText("moved card", { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText("column: Up Next → In progress")).toBeInTheDocument();
    expect(within(dialog).getByText("joined the project", { exact: false })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: `Open ${card.title}` }));
    expect(await screen.findByRole("dialog", { name: "Edit card" })).toBeInTheDocument();
  });

  it("shows recent changes inside the card it opens", async () => {
    const initial = boardFixture();
    const card = initial.cards.find((candidate) => candidate.status === "in_progress")!;
    stubFetch(authenticatedFetch(initial), {
      hasMore: false,
      events: [auditFixture({
        action: "updated",
        entityId: card.id,
        entityTitle: card.title,
        changes: [{ field: "assignee", from: "unassigned", to: "Maren" }],
      })],
    });

    render(<App />);
    await openWorkCard(card);

    const dialog = screen.getByRole("dialog", { name: "Edit card" });
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
    entityType: "card",
    entityId: null,
    entityTitle: "a card",
    action: "updated",
    changes: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
