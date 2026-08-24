// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { Page } from "../../shared/types";
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

function authenticatedFetch(board = boardFixture()) {
  return vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => response({ status: "authenticated", user: board.currentUser }))
    .mockImplementationOnce(() => response(board));
}

function stubFetch(mock: typeof fetch) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.startsWith("/api/activity")) {
      return response({
        events: [
          {
            sequence: 4,
            id: "event-1",
            actorId: "00000000-0000-4000-8000-000000000011",
            actorName: "Maren",
            entityType: "page",
            entityId: "00000000-0000-4000-8000-000000000020",
            entityTitle: "Make the tower door remember Maren",
            action: "updated",
            changes: [],
            createdAt: new Date().toISOString(),
          },
        ],
        hasMore: false,
      });
    }
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/seen")) return response({ ok: true });
    return mock(input, init);
  });
}

async function openPage(page: Page) {
  await userEvent.click(await screen.findByRole("button", { name: /open backlog/i }));
  await userEvent.click(await screen.findByText(page.title, { exact: true }));
  await screen.findByRole("dialog", { name: "Edit page" });
}

/** A live workspace event, so a teammate's change reaches an open dialog the way it really does. */
function installEventSource(): { push: () => void } {
  let listener: ((event: Event) => void) | null = null;
  class FakeEventSource {
    close = vi.fn();
    constructor(readonly url: string) {}
    addEventListener(type: string, value: EventListener) {
      if (type === "workspace") listener = value;
    }
    removeEventListener = vi.fn();
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  return { push: () => listener?.(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) })) };
}

describe("editing a page someone else is also changing", () => {
  it("adopts a teammate's notes into a field the reader has not touched", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const theirs = "Maren: the door should remember both wizards, not just one.";
    const updated = { ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]] };
    const live = installEventSource();
    const fetchMock = authenticatedFetch(initial).mockImplementationOnce(() => response(updated));
    stubFetch(fetchMock);

    render(<App />);
    await openPage(page);
    expect(screen.getByText(page.description)).toBeInTheDocument();

    live.push();

    // The reader was not writing here, so their version simply arrives, and says who wrote it.
    expect(await screen.findByText(theirs)).toBeInTheDocument();
    expect(await screen.findByText(/notes updated by Maren/i)).toBeInTheDocument();
  });

  it("refuses to overwrite notes that changed underneath, and offers the choice", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const theirs = "Maren: three slots, not four.";
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() =>
        response(
          { error: "These notes changed while you were writing", conflict: true, field: "description", current: { ...page, description: theirs } },
          409,
        ),
      )
      .mockImplementationOnce(() => response({ ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]] }));
    stubFetch(fetchMock);

    render(<App />);
    await openPage(page);

    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), "Four slots feels better.");

    const alert = await screen.findByRole("alert", {}, { timeout: 2_000 });
    expect(alert).toHaveTextContent(/changed these notes while you were writing/i);
    expect(alert).toHaveTextContent(theirs);
    expect(screen.getByRole("button", { name: "keep mine" })).toBeInTheDocument();
    // A refusal is answered in the editor, never by the global banner.
    expect(screen.queryByText("These notes changed while you were writing")).not.toBeInTheDocument();
  });

  it("takes the teammate's version when the reader chooses it", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const theirs = "Maren: three slots, not four.";
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() =>
        response(
          { error: "These notes changed while you were writing", conflict: true, field: "description", current: { ...page, description: theirs } },
          409,
        ),
      )
      .mockImplementationOnce(() => response({ ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]] }));
    stubFetch(fetchMock);

    render(<App />);
    await openPage(page);
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), "Four slots feels better.");
    await screen.findByRole("alert", {}, { timeout: 2_000 });

    await userEvent.click(screen.getByRole("button", { name: "use theirs" }));

    expect(screen.getByLabelText("Notes")).toHaveValue(theirs);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Choosing their text is not a new edit, so nothing further is written.
    const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(writes).toHaveLength(1);
  });

  it("writes the reader's version only when they say to keep it", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const theirs = "Maren: three slots, not four.";
    const mine = "Four slots feels better.";
    const fetchMock = authenticatedFetch(initial)
      .mockImplementationOnce(() =>
        response(
          { error: "These notes changed while you were writing", conflict: true, field: "description", current: { ...page, description: theirs } },
          409,
        ),
      )
      .mockImplementationOnce(() => response({ ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]] }))
      .mockImplementationOnce(() => response({ page: { ...page, description: mine } }))
      .mockImplementationOnce(() => response({ ...initial, pages: [{ ...page, description: mine }, initial.pages[1]] }));
    stubFetch(fetchMock);

    render(<App />);
    await openPage(page);
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), mine);
    await screen.findByRole("alert", {}, { timeout: 2_000 });

    await userEvent.click(screen.getByRole("button", { name: "keep mine" }));

    // The retry expects their value, which is now what storage holds, so it lands.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ description: mine, expectedDescription: theirs }),
        }),
      ),
    );
  });

  it("does not collide with its own in-flight save when the page is closed", async () => {
    const initial = boardFixture();
    const page = initial.pages[0];
    const note = "One pass over the door text.";
    let releaseSave: (() => void) | null = null;
    const fetchMock = authenticatedFetch(initial)
      // Held open so closing happens while the debounced save is still in the air.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSave = () => resolve(new Response(JSON.stringify({ page: { ...page, description: note } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }));
          }),
      )
      .mockImplementationOnce(() => response({ ...initial, pages: [{ ...page, description: note }, initial.pages[1]] }));
    stubFetch(fetchMock);

    render(<App />);
    await openPage(page);
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), note);
    await waitFor(() => expect(releaseSave).not.toBeNull(), { timeout: 2_000 });

    await userEvent.click(screen.getByRole("button", { name: "Close page" }));
    releaseSave!();

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());
    const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes the page dialog on Escape", async () => {
    const initial = boardFixture();
    const fetchMock = authenticatedFetch(initial);
    stubFetch(fetchMock);

    render(<App />);
    await openPage(initial.pages[0]);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());
  });
});
