// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, DiscussionThread } from "../../shared/types";
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

const ME = "00000000-0000-4000-8000-000000000010";
const THEM = "00000000-0000-4000-8000-000000000011";

function message(authorId: string, authorName: string, body: string, agentName: string | null = null) {
  return {
    id: `m-${body.slice(0, 8)}`,
    authorId,
    authorName,
    agentName,
    body,
    createdAt: new Date().toISOString(),
  };
}

function thread(overrides: Partial<DiscussionThread> & { body: string; authorId: string; authorName: string }): DiscussionThread {
  return {
    ...message(overrides.authorId, overrides.authorName, overrides.body),
    id: overrides.id ?? `t-${overrides.body.slice(0, 8)}`,
    replies: [],
    answeredAt: null,
    answeredById: null,
    answeredByName: null,
    ...overrides,
  } as DiscussionThread;
}

type Calls = Array<{ url: string; method: string; body: unknown }>;

/** Mounts the board with a fixed set of threads, and records every write that leaves. */
function mountWith(threads: DiscussionThread[], board: BoardWorkspace = boardFixture()): Calls {
  const calls: Calls = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response({ ok: true });
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
}

/** The control inside the second column that chooses what it shows. */
function aside() {
  return document.querySelector(".aside-switch") as HTMLElement;
}

function section() {
  return document.querySelector(".page-discussion") as HTMLElement;
}

/**
 * Opens a page, and turns the second column to the conversation unless asked not to.
 *
 * A page opens on its properties, so almost everything here has to ask for the conversation
 * first - which is itself the behaviour the first test pins down.
 */
async function openPage(board: BoardWorkspace, { discussion = true } = {}) {
  const user = userEvent.setup();
  await user.click(await screen.findByText(board.pages[1].title));
  await screen.findByRole("dialog", { name: "Edit page" });
  if (discussion) await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));
  return user;
}

describe("the discussion on a page", () => {
  it("shares the second column with the properties rather than taking one of its own", async () => {
    const board = boardFixture();
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    await openPage(board);

    const split = document.querySelector(".page-editor-split") as HTMLElement;
    const columns = [...split.children].map((column) => column.className.split(" ")[0]);
    // Two columns, always. The writing, and whatever the second one has been turned to.
    expect(columns).toEqual(["page-editor-main", "page-aside"]);
    expect(document.querySelector(".page-aside")?.contains(section())).toBe(true);
    // The properties are not on screen at the same time; they took turns.
    expect(document.querySelector(".page-rail")).toBeNull();
  });

  it("opens on the properties, not on the conversation", async () => {
    const board = boardFixture();
    board.pages[1].openThreads = 4;
    board.pages[1].unseenMessages = 4;
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    await openPage(board, { discussion: false });

    // A page opens on what it is, not on what was said about it - however much is waiting.
    expect(document.querySelector(".page-rail")).toBeTruthy();
    expect(section()).toBeNull();
  });

  it("leaves the writing column exactly where it was, either way", async () => {
    const board = boardFixture();
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    const user = await openPage(board, { discussion: false });

    const split = document.querySelector(".page-editor-split") as HTMLElement;
    const before = split.className;
    // Nothing about the split changes when the second column swaps what it holds: no state
    // attribute, no track to travel, no width for the notes to give up.
    expect(split.getAttribute("data-discussion")).toBeNull();

    await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));
    expect(split.className).toBe(before);
    expect(split.getAttribute("data-discussion")).toBeNull();
  });

  it("switches back to the properties from the same control", async () => {
    const board = boardFixture();
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    const user = await openPage(board);

    expect(within(aside()).getByRole("button", { name: /Discussion/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(aside()).getByRole("button", { name: "Details" })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(aside()).getByRole("button", { name: "Details" }));
    expect(document.querySelector(".page-rail")).toBeTruthy();
    expect(section()).toBeNull();
  });

  it("counts what has not been read, and says nothing when there is nothing", async () => {
    const board = boardFixture();
    board.pages[1].unseenMessages = 3;
    // Resolved-ness is a different question, and not the one this number answers.
    board.pages[1].openThreads = 0;
    mountWith([], board);
    await openPage(board, { discussion: false });

    expect(within(aside()).getByText("3")).toBeTruthy();
    expect(within(aside()).getByLabelText("3 unread")).toBeTruthy();

    cleanup();
    const read = boardFixture();
    read.pages.forEach((page) => { page.unseenMessages = 0; page.openThreads = 5; });
    mountWith([], read);
    await openPage(read, { discussion: false });
    // Five open threads you have already read are not news.
    expect(document.querySelector(".discussion-unseen")).toBeNull();
  });

  it("marks the conversation read when it is turned to, and not before", async () => {
    const board = boardFixture();
    board.pages[1].unseenMessages = 2;
    const calls = mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    const user = await openPage(board, { discussion: false });

    // Opening the page is not reading the conversation.
    expect(calls.filter((call) => call.url.includes("/discussion/seen"))).toHaveLength(0);

    await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));
    const seen = calls.filter((call) => call.url.includes("/discussion/seen"));
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
  });

  it("says the word and the count in exactly one place", async () => {
    const board = boardFixture();
    board.pages[1].unseenMessages = 2;
    mountWith([
      thread({ authorId: THEM, authorName: "Maren", body: "One?" }),
      thread({ authorId: THEM, authorName: "Maren", body: "Two?" }),
    ], board);
    await openPage(board);

    // The switch is the label, the count, and the way in and out. A heading inside the column
    // would be a second thing saying the same word and a second way to leave it.
    expect(within(aside()).getByText("2")).toBeTruthy();
    expect(within(section()).queryByText(/^Discussion$/)).toBeNull();
    expect(document.querySelector(".discussion-toggle")).toBeNull();
  });

  it("shows a thread's actions only when it is reached for", async () => {
    const board = boardFixture();
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    await openPage(board);

    // Both live in one cluster rather than standing under every thread; at rest a thread is
    // a name, a time, and what was said, and the stylesheet is what reveals them.
    const actions = document.querySelector(".thread-actions") as HTMLElement;
    expect(actions).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "reply" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "answered" })).toBeTruthy();
    expect(document.querySelectorAll(".discussion-thread > .thread-reply")).toHaveLength(0);
  });

  it("sits beside the history rather than inside it", async () => {
    const board = boardFixture();
    mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    await openPage(board);

    const discussion = section();
    const history = document.querySelector(".page-history") as HTMLElement;
    expect(discussion).toBeTruthy();
    expect(history).toBeTruthy();
    // Two sections, neither containing the other: the whole point of the design.
    expect(discussion.contains(history)).toBe(false);
    expect(history.contains(discussion)).toBe(false);
    // What was said lives in the discussion, and not in the trail underneath it.
    expect(within(discussion).getByText("Whose clock?")).toBeTruthy();
    expect(within(history).queryByText("Whose clock?")).toBeNull();
  });

  it("folds what has been answered away until it is asked for", async () => {
    const board = boardFixture();
    const now = new Date().toISOString();
    mountWith([
      thread({ authorId: THEM, authorName: "Maren", body: "Still deciding this one" }),
      thread({
        authorId: THEM,
        authorName: "Maren",
        body: "Settled a while ago",
        answeredAt: now,
        answeredById: ME,
        answeredByName: "Donavyn",
      }),
    ], board);
    const user = await openPage(board);

    const discussion = section();
    expect(within(discussion).queryByText("Settled a while ago")).toBeNull();

    await user.click(within(discussion).getByRole("button", { name: /1 answered/ }));
    expect(within(discussion).getByText("Settled a while ago")).toBeTruthy();
    expect(within(discussion).getByText(/Answered by Donavyn/)).toBeTruthy();
  });

  it("says nothing about whose turn it is", async () => {
    const board = boardFixture();
    mountWith([
      thread({ id: "t-theirs", authorId: THEM, authorName: "Maren", body: "Asked of you" }),
      thread({ id: "t-mine", authorId: ME, authorName: "Donavyn", body: "Asked by you" }),
    ], board);
    await openPage(board);

    // A conversation between two people about one page does not need to be told who should
    // speak next, and saying so on every other thread turned reading it into being chased.
    for (const element of document.querySelectorAll(".discussion-thread")) {
      expect(element.className).not.toContain("needs-you");
    }
    expect(within(section()).queryByText("waiting on you")).toBeNull();
    expect(document.querySelector(".message-note")).toBeNull();
  });

  it("names the agent beside the person it wrote for", async () => {
    const board = boardFixture();
    mountWith([
      thread({
        authorId: THEM,
        authorName: "Maren",
        body: "Deployed to dev; smoke tests green.",
        agentName: "Planning agent",
      } as Partial<DiscussionThread> & { body: string; authorId: string; authorName: string }),
    ], board);
    await openPage(board);

    const discussion = section();
    expect(within(discussion).getByText("Maren")).toBeTruthy();
    expect(within(discussion).getByText("via Planning agent")).toBeTruthy();
  });

  it("opens a thread with what was typed", async () => {
    const board = boardFixture();
    const calls = mountWith([], board);
    const user = await openPage(board);

    await user.type(screen.getByLabelText("Start a thread"), "Does this need a migration?");
    await user.click(within(section()).getByRole("button", { name: "start a thread" }));

    const posted = calls.find((call) => call.url.endsWith("/discussion"));
    expect(posted?.method).toBe("POST");
    expect(posted?.body).toEqual({ body: "Does this need a migration?" });
  });

  it("will not post an empty message", async () => {
    const board = boardFixture();
    const calls = mountWith([], board);
    const user = await openPage(board);

    const send = within(section()).getByRole("button", { name: "start a thread" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Start a thread"), "   ");
    expect(send).toBeDisabled();
    expect(calls.filter((call) => call.url.endsWith("/discussion"))).toHaveLength(0);
  });

  it("replies into the thread that was asked, not a new one", async () => {
    const board = boardFixture();
    const calls = mountWith([
      thread({ id: "t-clock", authorId: THEM, authorName: "Maren", body: "Whose clock?" }),
    ], board);
    const user = await openPage(board);

    await user.click(within(section()).getByRole("button", { name: "reply" }));
    await user.type(screen.getByLabelText("Reply"), "Device time for display.");
    await user.click(within(section()).getByRole("button", { name: "reply" }));

    const posted = calls.find((call) => call.url.includes("/replies"));
    expect(posted?.url).toContain("/discussion/t-clock/replies");
    expect(posted?.body).toEqual({ body: "Device time for display." });
  });

  it("marks a thread answered", async () => {
    const board = boardFixture();
    const calls = mountWith([
      thread({ id: "t-open", authorId: THEM, authorName: "Maren", body: "Whose clock?" }),
    ], board);
    const user = await openPage(board);

    await user.click(within(section()).getByRole("button", { name: "answered" }));
    const posted = calls.find((call) => call.url.includes("/answered"));
    expect(posted?.url).toContain("/discussion/t-open/answered");
    expect(posted?.body).toEqual({ answered: true });
  });

  it("says plainly when nothing has been asked", async () => {
    const board = boardFixture();
    mountWith([], board);
    await openPage(board);

    expect(within(section()).getByText("Nothing has been said here yet.")).toBeTruthy();
  });
});

describe("open threads on a board tile", () => {
  it("shows a count only while something is waiting", async () => {
    const board = boardFixture();
    board.pages[1].openThreads = 2;
    board.pages[0].openThreads = 0;
    mountWith([], board);

    expect(await screen.findByTitle("2 open threads")).toBeTruthy();
    expect(screen.queryByTitle("0 open threads")).toBeNull();
  });

  it("says it in the singular for one", async () => {
    const board = boardFixture();
    board.pages[1].openThreads = 1;
    mountWith([], board);

    expect(await screen.findByTitle("1 open thread")).toBeTruthy();
  });
});
