// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BoardWorkspace, Page } from "../../shared/types";
import { App } from "../../src/App";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, type RouteReply, response, routeFetch } from "../fixtures/ui";

installUiHarness();

/** The activity backdrop every test mounts over: Maren has been editing the page being read. */
function marenActivity() {
  return {
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
  };
}

/** Mounts the app over a live workspace, with a test's own routes checked first. */
function mountApp(board: BoardWorkspace | (() => BoardWorkspace), routes: Record<string, RouteReply> = {}) {
  const { fetchMock } = routeFetch({ board, routes: { ...routes, "GET /api/activity": marenActivity() } });
  render(<App />);
  return fetchMock;
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
  return {
    push: () => listener?.(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) })),
  };
}

describe("editing a page someone else is also changing", () => {
  it("adopts a teammate's notes into a field the reader has not touched", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const theirs = "Maren: the door should remember both wizards, not just one.";
    const updated = { ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]!] };
    const live = installEventSource();
    let workspace = initial;
    mountApp(() => workspace);

    await openPage(page);
    expect(screen.getByText(page.description)).toBeInTheDocument();

    workspace = updated;
    live.push();

    // The reader was not writing here, so their version simply arrives, and says who wrote it.
    expect(await screen.findByText(theirs)).toBeInTheDocument();
    expect(await screen.findByText(/notes updated by Maren/i)).toBeInTheDocument();
  });

  it("refuses to overwrite notes that changed underneath, and offers the choice", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const theirs = "Maren: three slots, not four.";
    let workspace = initial;
    mountApp(() => workspace, {
      [`PATCH /api/pages/${page.id}`]: () => {
        workspace = { ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]!] };
        return response(
          {
            error: "These notes changed while you were writing",
            conflict: true,
            field: "description",
            current: { ...page, description: theirs },
          },
          409,
        );
      },
    });

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
    const page = initial.pages[0]!;
    const theirs = "Maren: three slots, not four.";
    let workspace = initial;
    const fetchMock = mountApp(() => workspace, {
      [`PATCH /api/pages/${page.id}`]: () => {
        workspace = { ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]!] };
        return response(
          {
            error: "These notes changed while you were writing",
            conflict: true,
            field: "description",
            current: { ...page, description: theirs },
          },
          409,
        );
      },
    });

    await openPage(page);
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), "Four slots feels better.");
    await screen.findByRole("alert", {}, { timeout: 2_000 });

    await userEvent.click(screen.getByRole("button", { name: "use theirs" }));

    // The notes are a rendered surface rather than a box with a value in it, so their
    // text is what it shows - which is also the proof the adopted version really landed.
    expect(screen.getByLabelText("Notes").textContent).toBe(theirs);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Choosing their text is not a new edit, so nothing further is written.
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
  });

  it("writes the reader's version only when they say to keep it", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const theirs = "Maren: three slots, not four.";
    const mine = "Four slots feels better.";
    let workspace = initial;
    const fetchMock = mountApp(() => workspace, {
      // The server's compare-and-swap: the write that expects what storage holds is the one
      // that lands, and the first save still expects the description the reader opened on.
      [`PATCH /api/pages/${page.id}`]: ({ body }) => {
        const write = body as { expectedDescription?: string };
        if (write.expectedDescription === theirs) {
          workspace = { ...initial, pages: [{ ...page, description: mine }, initial.pages[1]!] };
          return { page: { ...page, description: mine } };
        }
        workspace = { ...initial, pages: [{ ...page, description: theirs }, initial.pages[1]!] };
        return response(
          {
            error: "These notes changed while you were writing",
            conflict: true,
            field: "description",
            current: { ...page, description: theirs },
          },
          409,
        );
      },
    });

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
    const page = initial.pages[0]!;
    const note = "One pass over the door text.";
    let releaseSave: (() => void) | null = null;
    let workspace = initial;
    const fetchMock = mountApp(() => workspace, {
      // Held open so closing happens while the debounced save is still in the air.
      [`PATCH /api/pages/${page.id}`]: () =>
        new Promise<Response>((resolve) => {
          releaseSave = () => {
            workspace = { ...initial, pages: [{ ...page, description: note }, initial.pages[1]!] };
            resolve(response({ page: { ...page, description: note } }));
          };
        }),
    });

    await openPage(page);
    await userEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), note);
    await waitFor(() => expect(releaseSave).not.toBeNull(), { timeout: 2_000 });

    await userEvent.click(screen.getByRole("button", { name: "Close page" }));
    releaseSave!();

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes the page dialog on Escape", async () => {
    const initial = boardFixture();
    mountApp(initial);

    await openPage(initial.pages[0]!);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());
  });
});
