// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText(initial.cards[0].title)).toBeInTheDocument();

    workspaceListener!(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) }));

    expect(await screen.findByText(liveCard.title)).toBeInTheDocument();
  });

  it("prefills the default owner email during first-run setup", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementationOnce(() => response({ status: "setup_required" })));

    render(<App />);

    expect(await screen.findByLabelText("Email")).toHaveValue("owner@example.com");
  });

  it("lands directly on one compact four-column board", async () => {
    const fetchMock = authenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Wizard Simulator" })).toBeInTheDocument();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
      "Backlog",
      "Ready",
      "In progress",
      "Done",
    ]);
    expect(screen.getByText("Model the potion workbench")).toBeInTheDocument();
    expect(screen.getByText("Maren")).toBeInTheDocument();
    const capture = screen.getByLabelText(/add a card to backlog/i);
    expect(capture).toHaveFocus();
    expect(capture.closest("form")).toHaveClass("workspace-capture");
    expect(screen.queryByText("one board, one source of truth", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/design pillar/i)).not.toBeInTheDocument();
  });

  it("places the Work and Ideas switcher beside the product identity", async () => {
    const fetchMock = authenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Project spaces" });
    expect(navigation.parentElement).toHaveClass("brand-lockup");
    expect(screen.getByRole("heading", { name: "Wizard Simulator" }).parentElement).toHaveClass("board-project");
  });

  it("switches between Work and Ideas with 1 and 2 from an empty capture field", async () => {
    const initial = boardFixture();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(ideaFixture()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByLabelText(/add a card to backlog/i)).toHaveFocus();

    await userEvent.keyboard("2");
    expect(await screen.findByRole("heading", { name: "Idea garden" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture an idea")).toHaveFocus();
    expect(window.location.search).toContain("view=ideas");

    await userEvent.keyboard("1");
    expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByLabelText(/add a card to backlog/i)).toHaveFocus();
    expect(window.location.search).not.toContain("view=ideas");

    await userEvent.type(screen.getByLabelText(/add a card to backlog/i), "room 2");
    expect(screen.getByLabelText(/add a card to backlog/i)).toHaveValue("room 2");
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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const input = await screen.findByLabelText(/add a card to backlog/i);
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByText(created.title)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cards",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"status":"backlog"') }),
    );
  });

  it("moves a card by dropping it into another column", async () => {
    const initial = boardFixture();
    const moved = { ...initial.cards[0], status: "in_progress" as const, position: 1 };
    const updated = { ...initial, cards: [moved, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const card = await screen.findByText(initial.cards[0].title);
    const column = screen.getByRole("region", { name: "In progress" });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => initial.cards[0].id), effectAllowed: "move" };
    fireEvent.dragStart(card.closest("article")!, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cards/${initial.cards[0].id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "in_progress", position: 1 }),
        }),
      ),
    );
  });

  it("keeps drag and drop active while person filters are applied", async () => {
    const initial = boardFixture();
    const card = initial.cards[1];
    const moved = { ...card, status: "backlog" as const, position: 1 };
    const updated = { ...initial, cards: [initial.cards[0], moved] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: moved }))
      .mockImplementationOnce(() => response(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Filter by Maren" }));
    const cardTitle = screen.getByText(card.title);
    const backlog = screen.getByRole("region", { name: "Backlog" });
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

  it("edits a card with member buttons instead of dropdowns", async () => {
    const initial = boardFixture();
    const card = initial.cards[0];
    const assigned = { ...card, assigneeId: initial.members[1].id, assigneeName: "Maren" };
    const updated = { ...initial, cards: [assigned, initial.cards[1]] };
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() => response({ card: assigned }))
      .mockImplementationOnce(() => response(updated));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`Open ${card.title}`, "i") }));

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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const openCard = await screen.findByRole("button", { name: new RegExp(`Open ${card.title}`, "i") });
    expect(openCard).toHaveTextContent("narrative");
    await userEvent.click(openCard);

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
    expect(await screen.findByText("blocked by 1")).toBeInTheDocument();
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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`Open ${card.title}`, "i") }));

    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`Open ${card.title}`, "i") }));
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
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`Open ${card.title}`, "i") }));
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
    vi.stubGlobal("fetch", fetchMock);

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

  it("keeps ideas in a separate ranked garden", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(ideaWorkspace));
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = authenticatedFetch(initial);
    vi.stubGlobal("fetch", fetchMock);

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
    expect(screen.queryByText("Make the tower door remember Maren")).not.toBeInTheDocument();
    expect(screen.queryByText("Model the potion workbench")).not.toBeInTheDocument();
    expect(window.location.search).toContain(`people=${initial.currentUser.id}`);

    await userEvent.click(myWork);
    await userEvent.click(screen.getByRole("button", { name: "Filter by Maren" }));
    expect(screen.queryByText("Make the tower door remember Maren")).not.toBeInTheDocument();
    expect(screen.getByText("Model the potion workbench")).toBeInTheDocument();
    expect(window.location.search).toContain(`people=${initial.members[1].id}`);
  });
});
