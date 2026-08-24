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

async function openPage(board: BoardWorkspace) {
  const user = userEvent.setup();
  await user.click(await screen.findByText(board.pages[1].title));
  await screen.findByRole("dialog", { name: "Edit page" });
  return user;
}

function section() {
  return document.querySelector(".page-discussion") as HTMLElement;
}

describe("the discussion on a page", () => {
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

  it("counts what is open and folds what has been answered away", async () => {
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
    expect(within(discussion).getByText("1 open")).toBeTruthy();
    // The answered one is out of the way until it is asked for - that is what keeps this short.
    expect(within(discussion).queryByText("Settled a while ago")).toBeNull();

    await user.click(within(discussion).getByRole("button", { name: /1 answered/ }));
    expect(within(discussion).getByText("Settled a while ago")).toBeTruthy();
    expect(within(discussion).getByText(/Answered by Donavyn/)).toBeTruthy();
  });

  it("marks a thread whose turn is yours, and leaves your own alone", async () => {
    const board = boardFixture();
    mountWith([
      thread({ id: "t-theirs", authorId: THEM, authorName: "Maren", body: "Asked of you" }),
      thread({ id: "t-mine", authorId: ME, authorName: "Donavyn", body: "Asked by you" }),
    ], board);
    await openPage(board);

    const theirs = document.querySelectorAll(".discussion-thread")[0] as HTMLElement;
    expect(theirs.className).toContain("needs-you");
    expect(within(theirs).getByText("waiting on you")).toBeTruthy();

    const mine = document.querySelectorAll(".discussion-thread")[1] as HTMLElement;
    expect(mine.className).not.toContain("needs-you");
    expect(within(mine).queryByText("waiting on you")).toBeNull();
  });

  it("hands the turn back once you have replied", async () => {
    const board = boardFixture();
    mountWith([
      thread({
        authorId: THEM,
        authorName: "Maren",
        body: "Asked of you",
        replies: [message(ME, "Donavyn", "Answered it")],
      }),
    ], board);
    await openPage(board);

    const only = document.querySelector(".discussion-thread") as HTMLElement;
    expect(only.className).not.toContain("needs-you");
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
    expect(calls.filter((call) => call.url.includes("/discussion"))).toHaveLength(0);
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

  it("marks a thread answered, and offers to reopen one", async () => {
    const board = boardFixture();
    const calls = mountWith([
      thread({ id: "t-open", authorId: THEM, authorName: "Maren", body: "Whose clock?" }),
    ], board);
    const user = await openPage(board);

    await user.click(within(section()).getByRole("button", { name: "mark answered" }));
    const posted = calls.find((call) => call.url.includes("/answered"));
    expect(posted?.url).toContain("/discussion/t-open/answered");
    expect(posted?.body).toEqual({ answered: true });
  });

  it("says plainly when nothing has been asked", async () => {
    const board = boardFixture();
    mountWith([], board);
    await openPage(board);

    expect(within(section()).getByText("Nothing has been asked here yet.")).toBeTruthy();
    // No count appears for a page nobody has said anything about.
    expect(within(section()).queryByText(/open$/)).toBeNull();
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
