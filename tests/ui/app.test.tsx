// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, Page } from "../../shared/types";
import { App } from "../../src/App";
import { boardFixture, ideaFixture } from "../fixtures/board";
import { installUiHarness, response, routeFetch } from "../fixtures/ui";

installUiHarness();

/**
 * Gives an element a box, because jsdom gives everything a zero-sized one at the origin.
 *
 * The board decides which column a pointer is over by asking where the columns are, so a
 * drag test has to answer that question before it can be about dropping anything.
 */
function domRect(rect: { left: number; right: number; top: number; bottom: number }): DOMRect {
  return {
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubRect(node: Element, rect: { left: number; right: number; top: number; bottom: number }) {
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue(domRect(rect));
}

/**
 * Gives a column and the cards inside it a real stacked layout, answered at call time.
 *
 * Spying on individual card elements is fragile: React is free to build a fresh element for a
 * card when the placeholder appears beside it, and a spy bound to the old one goes with it.
 * Resolving from the prototype, by the card's current position among its siblings, stays true
 * however the tree is rebuilt.
 */
function layOutColumn(column: Element, top = 200, rowHeight = 50) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === column) return domRect({ left: 0, right: 500, top: 0, bottom: 900 });
    if (column.contains(this) && this.matches("article.board-page")) {
      const cards = Array.from(column.querySelectorAll("article.board-page:not(.drag-hidden)"));
      const index = cards.indexOf(this);
      if (index >= 0) {
        return domRect({
          left: 0,
          right: 500,
          top: top + index * rowHeight,
          bottom: top + (index + 1) * rowHeight,
        });
      }
    }
    return domRect({ left: 0, right: 0, top: 0, bottom: 0 });
  });
}

/**
 * Carries a card to a point the way a mouse does: press, travel, release.
 *
 * A mouse lifts a card as soon as it moves, so one move past the threshold is a whole drag.
 * Fingers are covered by the long-press tests, which hold still and wait instead.
 */
function dragWithPointer(card: Element, to: { x: number; y: number }) {
  fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: to.x, clientY: to.y });
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
      ...initial.pages[0]!,
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
    let workspace = initial;
    routeFetch({ board: () => workspace });

    render(<App />);
    expect(await screen.findByRole("button", { name: /open backlog/i })).toHaveTextContent("1");
    // The stream is opened by an effect, so the board can be on screen a tick before
    // anything is listening. Firing early made this test flaky.
    await waitFor(() => expect(workspaceListener).not.toBeNull());

    workspace = updated;
    workspaceListener!(new MessageEvent("workspace", { data: JSON.stringify({ scope: "work" }) }));

    await waitFor(() => expect(screen.getByRole("button", { name: /open backlog/i })).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: /open backlog/i }));
    expect(await screen.findByText(livePage.title)).toBeInTheDocument();
  });

  it("leaves the first-run email empty so an installation names its own owner", async () => {
    routeFetch({ routes: { "GET /api/session": { status: "setup_required" } } });

    render(<App />);

    const email = await screen.findByLabelText("Email");
    expect(email).toHaveValue("");
    expect(email).toHaveAttribute("placeholder", "you@example.com");
  });

  it("lands on a compact active deck while keeping backlog work out of sight", async () => {
    routeFetch();

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
    // A dropdown here means a native <select>. The quick capture carries role="combobox"
    // deliberately - it opens the capture picker's listbox - so match the element, not the role.
    expect(document.querySelector("select")).toBeNull();
    expect(screen.queryByText(/design pillar/i)).not.toBeInTheDocument();
  });

  it("places the Work and Ideas switcher beside the product identity", async () => {
    routeFetch();

    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Project spaces" });
    expect(navigation.parentElement).toHaveClass("brand-lockup");
    expect(
      screen.getByRole("heading", { name: "Wizard Simulator" }).closest(".board-project"),
    ).not.toBeNull();
    expect(screen.getByText("v0.6.1")).toBeInTheDocument();
  });

  /**
   * Stages a second project whose board answer the test holds open, so a switch can be
   * examined in flight rather than only after it has landed.
   */
  function stageProjectSwitch() {
    const initial = boardFixture();
    const nextProject = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Potion Shop",
      description: "",
    };
    initial.projects = [...initial.projects, nextProject];
    const next = { ...initial, project: { ...initial.project, ...nextProject }, pages: [] };
    let finishOpening!: (value: Response) => void;
    const opening = new Promise<Response>((resolve) => {
      finishOpening = resolve;
    });
    // The first board answer draws the deck; the switch's own answer is the held promise.
    let boardAnswer: () => unknown = () => initial;
    routeFetch({ board: initial, routes: { "GET /api/board": () => boardAnswer() } });

    return {
      open: async () => {
        await userEvent.click(await screen.findByRole("button", { name: "Wizard Simulator" }));
        boardAnswer = () => opening;
        await userEvent.click(screen.getByRole("menuitem", { name: "Potion Shop" }));
      },
      land: async () => finishOpening(await response(next)),
    };
  }

  it("leaves the board it is opening away from on screen, with nothing thrown over it", async () => {
    const staged = stageProjectSwitch();

    render(<App />);
    await staged.open();

    // The whole point: an open that lands quickly shows no loading state at all, so the
    // board being left is still the one on screen while the next one is being read.
    const leaving = screen.getByRole("heading", { name: "Wizard Simulator" });
    expect(leaving).toBeInTheDocument();
    expect(screen.queryByText("opening project...")).not.toBeInTheDocument();
    // Inert, because the client is already scoped to the project being opened: a click
    // landing on this board would write to the other one.
    expect(leaving.closest("[inert]")).toHaveClass("board-swap");

    await staged.land();
    expect(await screen.findByRole("heading", { name: "Potion Shop" })).toBeInTheDocument();
    expect(screen.queryByText("opening project...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Wizard Simulator" })).not.toBeInTheDocument();
    // The board that arrived is a working one. An `inert` left behind, or written as the
    // string "false" the way React used to, would be a board nobody can click.
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("raises the opening face only once the wait is slow enough to be worth saying", async () => {
    const staged = stageProjectSwitch();

    render(<App />);
    await staged.open();

    // Held open past the threshold, this is the wait that has earned an answer.
    const loading = await screen.findByText("opening project...");
    expect(loading.previousElementSibling).toHaveClass("brand-mark", "pulse");
    // Over the board rather than instead of it - what it covers is still underneath.
    expect(loading.closest(".loading-screen")).toHaveClass("over-board");
    expect(screen.getByRole("heading", { name: "Wizard Simulator" })).toBeInTheDocument();

    await staged.land();
    expect(await screen.findByRole("heading", { name: "Potion Shop" })).toBeInTheDocument();
    expect(screen.queryByText("opening project...")).not.toBeInTheDocument();
  });

  it("switches between Work and Ideas with 1 and 2 from an empty capture field", async () => {
    const initial = boardFixture();
    routeFetch({ board: initial, routes: { "GET /api/ideas": ideaFixture() } });

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
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000030",
      title: "Let the broom resent being used as a weapon",
    };
    const updated = { ...initial, pages: [created, ...initial.pages] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = updated;
          return response({ page: created }, 201);
        },
      },
    });

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

  it("offers the fresh page behind one key, guards it while typing, and spends it when taken", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000034",
      title: "Enchant the cellar door",
      status: "ready" as const,
      position: 0,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    let workspace = initial;
    routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = updated;
          return response({ page: created }, 201);
        },
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");

    // The announcement carries the way to the page it announces.
    expect(await screen.findByText(`Added ${created.title}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Open ${created.title}` })).toHaveTextContent("open");

    // The capture bar keeps focus for the next thought, so here "o" is a letter, not a command.
    await userEvent.keyboard("o");
    expect(input).toHaveValue("o");
    expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument();
    await userEvent.clear(input);

    // Away from the input the key answers, with the page that was just captured.
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("o");
    const dialog = await screen.findByRole("dialog", { name: "Edit page" });
    expect(within(dialog).getByDisplayValue(created.title)).toBeInTheDocument();
    // Taking the offer used it up.
    expect(screen.queryByText(`Added ${created.title}`)).not.toBeInTheDocument();
  });

  it("lets the open offer die with its toast", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000034",
      title: "Enchant the cellar door",
      position: 1,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    let workspace = initial;
    routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = updated;
          return response({ page: created }, 201);
        },
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");

    await screen.findByText(`Added ${created.title}`);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss undo" }));

    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("o");
    expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument();
  });

  it("starts the countdown over for each new notice", async () => {
    const initial = boardFixture();
    routeFetch({
      routes: {
        "POST /api/pages": (call) =>
          response(
            {
              page: {
                ...initial.pages[0]!,
                id: "00000000-0000-4000-8000-000000000034",
                title: (call.body as { title: string }).title,
              },
            },
            201,
          ),
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, "Enchant the cellar door");
    await userEvent.keyboard("{Enter}");
    await screen.findByText("Added Enchant the cellar door");
    const firstBar = document.querySelector(".undo-timer");

    await userEvent.type(input, "Oil the hinges");
    await userEvent.keyboard("{Enter}");
    await screen.findByText("Added Oil the hinges");

    // The bar is a CSS animation, and only a fresh element runs it from the start - so a
    // second announcement must not inherit the first one's half-spent bar.
    expect(document.querySelector(".undo-timer")).not.toBe(firstBar);
  });

  it("leaves no open offer standing after signing out", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000034",
      title: "Enchant the cellar door",
      status: "ready" as const,
      position: 0,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    let workspace = initial;
    routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = updated;
          return response({ page: created }, 201);
        },
        "POST /api/auth/login": () => response({ user: initial.currentUser }),
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, created.title);
    await userEvent.keyboard("{Enter}");
    await screen.findByText(`Added ${created.title}`);
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("o");
    await screen.findByRole("dialog", { name: "Edit page" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument());

    await userEvent.click(await screen.findByRole("button", { name: /open account settings/i }));
    await userEvent.click(screen.getByRole("button", { name: "sign out" }));
    await userEvent.type(await screen.findByLabelText("Email"), initial.currentUser.email);
    await userEvent.type(screen.getByLabelText("Password"), "correct horse wizard tower");
    await userEvent.click(screen.getByRole("button", { name: "sign in" }));

    // The board mounts again for the new session; the page it was once asked to open stays shut.
    await screen.findByLabelText("Capture work page");
    expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument();
  });

  it("keeps the backlog open and preserves its filters while moving several pages to Up Next", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const moved = { ...page, status: "ready" as const, position: 0 };
    const updated = { ...initial, pages: [moved, initial.pages[1]!] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        // One URL answers the move and its undo; the column asked for tells them apart.
        [`PATCH /api/pages/${page.id}`]: ({ body }) => {
          if ((body as { status: string }).status === "ready") {
            workspace = updated;
            return { page: moved };
          }
          workspace = initial;
          return { page };
        },
      },
    });

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
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "backlog", position: page.position }),
      }),
    );
  });

  it("keeps the last capture settings for the next page until the user starts fresh", async () => {
    const initial = boardFixture();
    const donavyn = initial.members[0]!;
    const maren = initial.members[1]!;
    const first = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000029",
      title: "Build the spell loadout",
      category: "code" as const,
      assigneeId: maren.id,
      assigneeName: maren.name,
      status: "ready" as const,
      position: 0,
    };
    const second = {
      ...first,
      id: "00000000-0000-4000-8000-000000000031",
      title: "Wire the spellbook tabs",
      assigneeId: donavyn.id,
      assigneeName: donavyn.name,
      position: 1,
    };
    const afterFirst = { ...initial, pages: [...initial.pages, first] };
    const afterSecond = { ...initial, pages: [...initial.pages, first, second] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": ({ body }) => {
          if ((body as { title: string }).title === first.title) {
            workspace = afterFirst;
            return response({ page: first }, 201);
          }
          workspace = afterSecond;
          return response({ page: second }, 201);
        },
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    expect(screen.queryByRole("button", { name: "Choose category" })).not.toBeInTheDocument();
    await userEvent.type(input, first.title);

    await userEvent.click(screen.getByRole("button", { name: "Choose category" }));
    await userEvent.click(screen.getByRole("option", { name: "Code" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose assignee" }));
    await userEvent.click(screen.getByRole("option", { name: "Maren" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose column" }));
    await userEvent.click(screen.getByRole("option", { name: "Up Next" }));
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(input).toHaveValue(""));
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Category: Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assignee: Maren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Column: Up Next" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: first.title,
          category: "code",
          chapter: null,
          assigneeId: maren.id,
          status: "ready",
        }),
      }),
    );

    await userEvent.type(input, second.title);
    await userEvent.click(screen.getByRole("button", { name: "Assignee: Maren" }));
    await userEvent.click(screen.getByRole("option", { name: "Donavyn" }));
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: second.title,
            category: "code",
            chapter: null,
            assigneeId: donavyn.id,
            status: "ready",
          }),
        }),
      ),
    );

    await userEvent.type(input, "Sketch the tavern");
    await userEvent.click(screen.getByRole("button", { name: "Start fresh with default settings" }));
    expect(screen.getByRole("button", { name: "Choose category" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose assignee" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose column" })).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("assigns the only member of a one-person project without being asked", async () => {
    const initial = boardFixture();
    const donavyn = initial.members[0]!;
    const alone = { ...initial, members: [donavyn] };
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000032",
      title: "Hang the tower door",
      assigneeId: donavyn.id,
      assigneeName: donavyn.name,
      position: 1,
    };
    let workspace = alone;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = { ...alone, pages: [...alone.pages, created] };
          return response({ page: created }, 201);
        },
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, created.title);

    // The default is on screen before it is sent, so it can be changed like any other choice.
    expect(screen.getByRole("button", { name: `Assignee: ${donavyn.name}` })).toBeInTheDocument();
    // And starting fresh is not offered, because it would put things back exactly as they are.
    expect(
      screen.queryByRole("button", { name: "Start fresh with default settings" }),
    ).not.toBeInTheDocument();

    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: created.title,
            category: null,
            chapter: null,
            assigneeId: donavyn.id,
            status: "backlog",
          }),
        }),
      ),
    );
  });

  it("carries that default into the column's own add form", async () => {
    const initial = boardFixture();
    const donavyn = initial.members[0]!;
    const alone = { ...initial, members: [donavyn] };
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000033",
      title: "Sketch the stair",
      assigneeId: donavyn.id,
      assigneeName: donavyn.name,
      position: 1,
    };
    let workspace = alone;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = { ...alone, pages: [...alone.pages, created] };
          return response({ page: created }, 201);
        },
      },
    });

    render(<App />);
    await screen.findByLabelText("Capture work page");
    await userEvent.click(screen.getAllByRole("button", { name: "+ add page" })[0]!);
    await userEvent.type(screen.getByPlaceholderText("Page title"), created.title);
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pages",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(`"assigneeId":"${donavyn.id}"`),
        }),
      ),
    );
  });

  it("leaves the assignee open as soon as there is somebody else it could be", async () => {
    routeFetch({ board: boardFixture() });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, "Decide who hangs the door");

    expect(screen.getByRole("button", { name: "Choose assignee" })).toBeInTheDocument();
  });

  it("uses inline commands to configure capture without adding them to the page title", async () => {
    const initial = boardFixture();
    const created = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000030",
      title: "Polish targeting reticle",
      category: "ui" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
      status: "in_progress" as const,
      position: 1,
    };
    const updated = { ...initial, pages: [...initial.pages, created] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/pages": () => {
          workspace = updated;
          return response({ page: created }, 201);
        },
      },
    });

    render(<App />);
    const input = await screen.findByLabelText("Capture work page");
    await userEvent.type(input, `${created.title} #u`);
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, "@don");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(input, "/in");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
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
      ),
    );
  });

  it("moves a page by dropping it into another column", async () => {
    const initial = boardFixture();
    const page = initial.pages[1]!;
    const moved = { ...page, status: "ready" as const, position: 0 };
    const updated = { ...initial, pages: [initial.pages[0]!, moved] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = updated;
          return { page: moved };
        },
      },
    });

    render(<App />);
    const pageTitle = await screen.findByText(page.title);
    const column = screen.getByRole("region", { name: "Up Next" });
    stubRect(column, { left: 300, right: 500, top: 100, bottom: 600 });
    dragWithPointer(pageTitle.closest("article")!, { x: 400, y: 300 });

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

  // The hold that separates a scroll from a lift is exercised against the hook itself, in
  // tests/ui/pointer-drag.test.tsx, where the clock can be driven without the whole app's
  // own timers running alongside it.

  it("moves a page with taps alone, which is the only path a keyboard has", async () => {
    const initial = boardFixture();
    const page = initial.pages[1]!;
    const moved = { ...page, status: "ready" as const, position: 0 };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = { ...initial, pages: [initial.pages[0]!, moved] };
          return { page: moved };
        },
      },
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: `Move ${page.title}` }));
    expect(screen.getByRole("status")).toHaveTextContent(/Moving/);

    await userEvent.click(screen.getByRole("button", { name: `Place ${page.title} in Up Next, position 1` }));

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
    const backlogPage = initial.pages[0]!;
    const progressPage = initial.pages[1]!;
    const readyA = {
      ...progressPage,
      id: "00000000-0000-4000-8000-000000000031",
      title: "Ready page A",
      status: "ready" as const,
      position: 0,
      assigneeId: null,
      assigneeName: null,
    };
    const readyB = {
      ...readyA,
      id: "00000000-0000-4000-8000-000000000032",
      title: "Ready page B",
      position: 1,
    };
    initial.pages = [backlogPage, progressPage, readyA, readyB];
    const moved = { ...progressPage, status: "ready" as const, position: 1 };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${progressPage.id}`]: () => {
          workspace = { ...initial, pages: [backlogPage, readyA, moved, readyB] };
          return { page: moved };
        },
      },
    });

    render(<App />);
    const dragged = (await screen.findByText(progressPage.title)).closest("article")!;
    const column = screen.getByRole("region", { name: "Up Next" });
    // Two ready cards stacked at 200-250 and 250-300, so a pointer at 260 is past the first
    // card's midpoint and short of the second's: the gap between them.
    layOutColumn(column);

    fireEvent.pointerDown(dragged, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 260 });
    expect(dragged).toHaveClass("drag-hidden");

    // The gap the pointer is pointing at, held open ahead of the drop.
    const placeholder = column.querySelector(".drop-placeholder");
    expect(placeholder).not.toBeNull();
    expect(placeholder!.nextElementSibling).toBe(screen.getByText(readyB.title).closest("article"));

    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 260 });
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
    const inboxIdea = ideas.ideas[1]!;
    const parkedIdea = { ...inboxIdea, state: "parked" as const, position: 1 };
    let ideaSpace = ideas;
    const { fetchMock } = routeFetch({
      board: initial,
      routes: {
        "GET /api/ideas": () => ideaSpace,
        [`PATCH /api/ideas/${inboxIdea.id}`]: () => {
          ideaSpace = { ...ideas, ideas: [ideas.ideas[0]!, parkedIdea, ideas.ideas[2]!] };
          return { idea: parkedIdea };
        },
      },
    });

    render(<App />);
    await screen.findByLabelText("Capture work page");
    await userEvent.keyboard("2");
    const dragged = (await screen.findByText(inboxIdea.title)).closest("article")!;
    const parked = screen.getByRole("region", { name: "Parked ideas" });
    stubRect(parked, { left: 600, right: 900, top: 100, bottom: 600 });
    dragWithPointer(dragged, { x: 700, y: 300 });

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
    const page = initial.pages[1]!;
    const moved = { ...page, status: "backlog" as const, position: 1 };
    const updated = { ...initial, pages: [initial.pages[0]!, moved] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = updated;
          return { page: moved };
        },
      },
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Filter by Maren" }));
    const pageTitle = screen.getByText(page.title);
    const backlog = screen.getByRole("button", { name: /open backlog/i });
    stubRect(backlog, { left: 20, right: 120, top: 200, bottom: 232 });
    dragWithPointer(pageTitle.closest("article")!, { x: 60, y: 215 });

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
      ...initial.pages[0]!,
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      title: `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const workspace = { ...initial, pages: [initial.pages[0]!, initial.pages[1]!, ...completed] };
    const reopened = { ...completed[0]!, status: "ready" as const, position: 0, completedAt: null };
    const afterReopen = {
      ...workspace,
      pages: [...workspace.pages.filter((page) => page.id !== reopened.id), reopened],
    };
    let liveBoard = workspace;
    const { fetchMock } = routeFetch({
      board: () => liveBoard,
      routes: {
        [`PATCH /api/pages/${reopened.id}`]: () => {
          liveBoard = afterReopen;
          return { page: reopened };
        },
      },
    });

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
      ...initial.pages[0]!,
      id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
      title: `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    routeFetch({ board: { ...initial, pages: [initial.pages[0]!, initial.pages[1]!, ...completed] } });

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
      ...initial.pages[0]!,
      id: `00000000-0000-4000-8000-${String(index + 400).padStart(12, "0")}`,
      title: index === 0 ? "Ancient sealed vault" : `Completed spell ${index + 1}`,
      status: "done" as const,
      position: index,
      completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    routeFetch({ board: { ...initial, pages: [initial.pages[0]!, initial.pages[1]!, ...completed] } });

    render(<App />);
    const done = await screen.findByRole("region", { name: "Done" });

    // Oldest of fourteen, so the ten-page column has no room for it.
    expect(done).not.toHaveTextContent("Ancient sealed vault");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search pages" }), "Ancient sealed");

    expect(done).toHaveTextContent("Ancient sealed vault");
  });

  it("edits a page with member buttons instead of dropdowns", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const maren = initial.members[1]!;
    const assigned = { ...page, assigneeId: maren.id, assigneeName: "Maren" };
    const updated = { ...initial, pages: [assigned, initial.pages[1]!] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = updated;
          return { page: assigned };
        },
      },
    });

    render(<App />);
    await openWorkPage(page);

    // A dropdown here means a native <select>. The quick capture carries role="combobox"
    // deliberately - it opens the capture picker's listbox - so match the element, not the role.
    expect(document.querySelector("select")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /assign maren/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ assigneeId: maren.id }) }),
      ),
    );
  });

  it("shows page categories and links blockers without a dropdown", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const blocker = initial.pages[1]!;
    const categorized = { ...page, category: "code" as const };
    const afterCategory = { ...initial, pages: [categorized, blocker] };
    const blocked = { ...categorized, blockedBy: [blocker.id] };
    const afterBlocker = { ...initial, pages: [blocked, blocker] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        // One URL, two edits: the field each write carries says which answer it earns.
        [`PATCH /api/pages/${page.id}`]: ({ body }) => {
          if ((body as { category?: string }).category) {
            workspace = afterCategory;
            return { page: categorized };
          }
          workspace = afterBlocker;
          return { page: blocked };
        },
      },
    });

    render(<App />);
    await openWorkPage(page);

    // A dropdown here means a native <select>. The quick capture carries role="combobox"
    // deliberately - it opens the capture picker's listbox - so match the element, not the role.
    expect(document.querySelector("select")).toBeNull();
    // Category is the one attribute folded to its current value, so it is read before it is
    // changed - and opening it still reveals plain buttons rather than a menu.
    const rail = screen.getByRole("dialog", { name: "Edit page" }).querySelector(".page-rail")!;
    expect(within(rail as HTMLElement).getByText("Narrative")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change category" }));
    // A dropdown here means a native <select>. The quick capture carries role="combobox"
    // deliberately - it opens the capture picker's listbox - so match the element, not the role.
    expect(document.querySelector("select")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Categorize as Code" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ category: "code" }) }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Add blocking page" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a blocking page" }), "potion");
    await userEvent.click(screen.getByRole("button", { name: `Blocked by ${blocker.title}` }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pages/${page.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ blockedBy: [blocker.id] }),
        }),
      ),
    );
    expect((await screen.findAllByText(blocker.title)).length).toBeGreaterThan(0);
  });

  it("opens a page straight from a shared link", async () => {
    const initial = boardFixture();
    const page = initial.pages[1]!;
    window.history.replaceState({}, "", `/?page=${page.id}`);
    routeFetch({ board: initial });

    render(<App />);
    await screen.findByRole("dialog", { name: "Edit page" });
    expect(screen.getByLabelText("Title")).toHaveValue(page.title);
  });

  it("keeps the open page in the URL and clears it on close", async () => {
    const initial = boardFixture();
    const page = initial.pages[1]!;
    routeFetch({ board: initial });

    render(<App />);
    await openWorkPage(page);
    expect(window.location.search).toContain(`page=${page.id}`);

    await userEvent.click(screen.getByRole("button", { name: "Close page" }));
    await waitFor(() => expect(window.location.search).not.toContain("page="));
  });

  it("drops a shared link to a page that no longer exists", async () => {
    const initial = boardFixture();
    window.history.replaceState({}, "", "/?page=00000000-0000-4000-8000-00000000dead");
    routeFetch({ board: initial });

    render(<App />);
    await screen.findByText(initial.pages[1]!.title);
    expect(screen.queryByRole("dialog", { name: "Edit page" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("page="));
  });

  it("opens an idea straight from a shared link in the ideas view", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    const idea = ideaWorkspace.ideas[0]!;
    window.history.replaceState({}, "", `/?view=ideas&idea=${idea.id}`);
    routeFetch({ board: initial, routes: { "GET /api/ideas": ideaWorkspace } });

    render(<App />);
    await screen.findByRole("dialog", { name: "Edit idea" });
    expect(screen.getByLabelText("Idea title")).toHaveValue(idea.title);
    expect(window.location.search).toContain(`idea=${idea.id}`);
  });

  it("automatically saves title and notes without a save button", async () => {
    const initial = boardFixture();
    const page = initial.pages[0]!;
    const note = "Keep the memory readable without subtitles.";
    const saved = { ...page, description: note };
    const updated = { ...initial, pages: [saved, initial.pages[1]!] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = updated;
          return { page: saved };
        },
      },
    });

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
    const page = initial.pages[0]!;
    const archived = { ...initial, pages: [initial.pages[1]!] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`DELETE /api/pages/${page.id}`]: () => {
          workspace = archived;
          return { ok: true };
        },
        [`POST /api/pages/${page.id}/restore`]: () => {
          workspace = initial;
          return { page };
        },
      },
    });

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
    const idea = ideaWorkspace.ideas[0]!;
    const promotedPage = {
      ...initial.pages[0]!,
      id: "00000000-0000-4000-8000-000000000050",
      title: idea.title,
      description: idea.description,
    };
    const promotedIdeas = {
      ...ideaWorkspace,
      ideas: ideaWorkspace.ideas.filter((candidate) => candidate.id !== idea.id),
    };
    const promotedBoard = { ...initial, pages: [...initial.pages, promotedPage] };
    let workspace = initial;
    let ideaSpace = ideaWorkspace;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "GET /api/ideas": () => ideaSpace,
        [`POST /api/ideas/${idea.id}/promote`]: () => {
          workspace = promotedBoard;
          ideaSpace = promotedIdeas;
          return response({ page: promotedPage }, 201);
        },
        [`DELETE /api/ideas/${idea.id}/promotion`]: () => {
          workspace = initial;
          ideaSpace = ideaWorkspace;
          return { idea };
        },
      },
    });

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
    const page = initial.pages[0]!;
    const title = "Make the tower door remember both wizards";
    const saved = { ...page, title };
    const updated = { ...initial, pages: [saved, initial.pages[1]!] };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`PATCH /api/pages/${page.id}`]: () => {
          workspace = updated;
          return { page: saved };
        },
      },
    });

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
    const { fetchMock } = routeFetch({ board: initial });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /open account settings/i }));

    expect(screen.getByRole("heading", { name: "Account settings" })).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Current password"), "correct horse wizard tower");
    await userEvent.type(screen.getByLabelText(/^New password/i), "an even newer secure wizard password");
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "an even newer secure wizard password",
    );
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
      members: initial.members.map((member) =>
        member.id === renamed.id ? { ...member, name: "Dono" } : member,
      ),
    };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        "POST /api/account/name": () => {
          workspace = updated;
          return { user: renamed };
        },
      },
    });

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
    expect(
      await screen.findByRole("button", { name: /open account settings for Dono/i }),
    ).toBeInTheDocument();
  });

  it("lets the owner remove a member from the team dialog", async () => {
    const initial = boardFixture();
    const removedMember = initial.members[1]!;
    const updated = {
      ...initial,
      members: initial.members.filter((member) => member.id !== removedMember.id),
      pages: initial.pages.map((page) =>
        page.assigneeId === removedMember.id ? { ...page, assigneeId: null, assigneeName: null } : page,
      ),
    };
    let workspace = initial;
    const { fetchMock } = routeFetch({
      board: () => workspace,
      routes: {
        [`DELETE /api/members/${removedMember.id}`]: () => {
          workspace = updated;
          return { ok: true };
        },
      },
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "team" }));

    expect(
      screen.queryByRole("button", { name: `Remove ${initial.currentUser.name}` }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Remove ${removedMember.name}` }));
    await userEvent.click(screen.getByRole("button", { name: `Confirm remove ${removedMember.name}` }));

    await waitFor(() => expect(screen.queryByText(removedMember.email)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/members/${removedMember.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lets the owner promote a member to owner, and offers the reverse afterwards", async () => {
    const initial = boardFixture();
    const promoted = initial.members[1]!;
    const updated = {
      ...initial,
      members: initial.members.map((member) =>
        member.id === promoted.id
          ? { ...member, role: "owner" as const, projectRole: "owner" as const }
          : member,
      ),
    };
    // The reload's members wear the API's own role word, which is not the fixture's type -
    // so the board travels through a route, exactly as the server would send it.
    let workspace: object = initial;
    const { fetchMock } = routeFetch({
      board: initial,
      routes: {
        "GET /api/board": () => workspace,
        [`PATCH /api/members/${promoted.id}`]: () => {
          workspace = updated;
          return { members: updated.members };
        },
      },
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "team" }));

    // An owner is never offered a control that would change their own role.
    expect(
      screen.queryByRole("button", { name: `Make ${initial.currentUser.name} a member` }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Make ${promoted.name} an owner` }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/members/${promoted.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "owner" }) }),
    );
    // The same button now reads the other way, because the promotion is reversible.
    expect(await screen.findByRole("button", { name: `Make ${promoted.name} a member` })).toBeInTheDocument();
  });

  it("explains that only the newest invite works for one person", async () => {
    const initial = boardFixture();
    routeFetch({ board: initial });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "team" }));

    expect(screen.getByText(/one person can use this link/i)).toBeInTheDocument();
    expect(screen.getByText(/creating another revokes this one/i)).toBeInTheDocument();
  });

  it("keeps ideas in a separate ranked garden", async () => {
    const initial = boardFixture();
    const ideaWorkspace = ideaFixture();
    routeFetch({ board: initial, routes: { "GET /api/ideas": ideaWorkspace } });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "ideas" }));

    expect(await screen.findByRole("heading", { name: "Idea garden" })).toBeInTheDocument();
    const capture = screen.getByLabelText("Capture an idea");
    expect(capture).toHaveFocus();
    expect(capture.closest("form")).toHaveClass("workspace-capture");
    expect(
      screen.queryByText("save possibility without growing the backlog", { exact: false }),
    ).not.toBeInTheDocument();
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
      ...ideaWorkspace.ideas[1]!,
      id: "00000000-0000-4000-8000-000000000043",
      title: "Let failed potions become useful materials",
    };
    const afterCapture = { ...ideaWorkspace, ideas: [...ideaWorkspace.ideas, captured] };
    const shortlisted = { ...captured, state: "shortlist" as const, position: 1 };
    const afterShortlist = {
      ...ideaWorkspace,
      ideas: [...ideaWorkspace.ideas, shortlisted].filter(
        (idea) => idea.id !== captured.id || idea === shortlisted,
      ),
    };
    let ideaSpace = ideaWorkspace;
    const { fetchMock } = routeFetch({
      board: initial,
      routes: {
        "GET /api/ideas": () => ideaSpace,
        "POST /api/ideas": () => {
          ideaSpace = afterCapture;
          return response({ idea: captured }, 201);
        },
        [`PATCH /api/ideas/${captured.id}`]: () => {
          ideaSpace = afterShortlist;
          return { idea: shortlisted };
        },
      },
    });

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
      ...initial.pages[0]!,
      status: "ready" as const,
      assigneeId: initial.currentUser.id,
      assigneeName: initial.currentUser.name,
    };
    const workspace = { ...initial, pages: [myPage, initial.pages[1]!] };
    routeFetch({ board: workspace });

    render(<App />);
    expect(await screen.findByRole("searchbox", { name: "Search pages" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "all work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "active" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mine" })).not.toBeInTheDocument();
    // A dropdown here means a native <select>. The quick capture carries role="combobox"
    // deliberately - it opens the capture picker's listbox - so match the element, not the role.
    expect(document.querySelector("select")).toBeNull();

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
    expect(window.location.search).toContain(`people=${initial.members[1]!.id}`);
  });

  it("reads the project history as sentences and opens the page behind an entry", async () => {
    const initial = boardFixture();
    const page = initial.pages.find((candidate) => candidate.status === "in_progress")!;
    routeFetch({
      board: initial,
      routes: {
        "GET /api/activity": {
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
              actorId: initial.members[1]!.id,
              entityType: "member",
              entityTitle: "Maren",
              id: "audit-2",
            }),
          ],
        },
      },
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

  it("keeps recent changes folded until the page asks for them", async () => {
    const initial = boardFixture();
    const page = initial.pages.find((candidate) => candidate.status === "in_progress")!;
    routeFetch({
      board: initial,
      routes: {
        "GET /api/activity": {
          hasMore: false,
          events: [
            auditFixture({
              action: "updated",
              entityId: page.id,
              entityTitle: page.title,
              changes: [{ field: "assignee", from: "unassigned", to: "Maren" }],
            }),
          ],
        },
      },
    });

    render(<App />);
    await openWorkPage(page);

    const dialog = screen.getByRole("dialog", { name: "Edit page" });
    const toggle = within(dialog).getByRole("button", { name: "History" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("assignee: unassigned → Maren")).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await within(dialog).findByText("assignee: unassigned → Maren")).toBeInTheDocument();
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
    routeFetch({ board: initial });

    render(<App />);
    const maren = await screen.findByRole("button", { name: "Filter by Maren" });
    expect(maren.querySelector(".avatar")).not.toHaveClass("online");

    // The stream is opened by an effect, which can flush after the board has painted. Firing
    // presence before the listener exists throws, so wait for the subscription itself rather
    // than treating the drawn board as proof of it.
    await waitFor(() => expect(presenceListener).not.toBeNull());

    act(() => {
      presenceListener!(
        new MessageEvent("presence", {
          data: JSON.stringify({ online: [initial.members[1]!.id] }),
        }),
      );
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
    agentTokenId: null,
    entityType: "page",
    entityId: null,
    entityTitle: "a page",
    action: "updated",
    changes: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
