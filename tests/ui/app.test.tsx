// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { boardFixture } from "../fixtures/board";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/design pillar/i)).not.toBeInTheDocument();
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
});
