// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, DiscussionThread } from "../../shared/types";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, response, routeFetch, type RecordedCall } from "../fixtures/ui";

installUiHarness();

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
    mentions: [] as string[],
  };
}

function thread(
  overrides: Partial<DiscussionThread> & { body: string; authorId: string; authorName: string },
): DiscussionThread {
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

/** Mounts the board with a fixed set of threads, and records every write that leaves. */
function mountWith(threads: DiscussionThread[], board: BoardWorkspace = boardFixture()): RecordedCall[] {
  // The only GET under /api/pages/ is a page's discussion, so the prefix is the regex.
  const { calls } = routeFetch({ board, routes: { "GET /api/pages/": { threads } } });
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
  await user.click(await screen.findByText(board.pages[1]!.title));
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
    board.pages[1]!.openThreads = 4;
    board.pages[1]!.unseenMessages = 4;
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

    expect(within(aside()).getByRole("button", { name: /Discussion/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(aside()).getByRole("button", { name: "Details" })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(aside()).getByRole("button", { name: "Details" }));
    expect(document.querySelector(".page-rail")).toBeTruthy();
    expect(section()).toBeNull();
  });

  it("counts what has not been read, and says nothing when there is nothing", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 3;
    // Resolved-ness is a different question, and not the one this number answers.
    board.pages[1]!.openThreads = 0;
    mountWith([], board);
    await openPage(board, { discussion: false });

    expect(within(aside()).getByText("3")).toBeTruthy();
    expect(within(aside()).getByLabelText("3 unread")).toBeTruthy();

    cleanup();
    const read = boardFixture();
    read.pages.forEach((page) => {
      page.unseenMessages = 0;
      page.openThreads = 5;
    });
    mountWith([], read);
    await openPage(read, { discussion: false });
    // Five open threads you have already read are not news.
    expect(document.querySelector(".discussion-unseen")).toBeNull();
  });

  it("marks the conversation read when it is turned to, and not before", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 2;
    const calls = mountWith([thread({ authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    const user = await openPage(board, { discussion: false });

    // Opening the page is not reading the conversation.
    expect(calls.filter((call) => call.url.includes("/discussion/seen"))).toHaveLength(0);

    await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));
    const seen = calls.filter((call) => call.url.includes("/discussion/seen"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
  });

  it("says the word and the count in exactly one place", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 2;
    mountWith(
      [
        thread({ authorId: THEM, authorName: "Maren", body: "One?" }),
        thread({ authorId: THEM, authorName: "Maren", body: "Two?" }),
      ],
      board,
    );
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
    mountWith(
      [
        thread({ authorId: THEM, authorName: "Maren", body: "Still deciding this one" }),
        thread({
          authorId: THEM,
          authorName: "Maren",
          body: "Settled a while ago",
          answeredAt: now,
          answeredById: ME,
          answeredByName: "Donavyn",
        }),
      ],
      board,
    );
    const user = await openPage(board);

    const discussion = section();
    expect(within(discussion).queryByText("Settled a while ago")).toBeNull();

    await user.click(within(discussion).getByRole("button", { name: /1 answered/ }));
    expect(within(discussion).getByText("Settled a while ago")).toBeTruthy();
    expect(within(discussion).getByText(/Answered by Donavyn/)).toBeTruthy();
  });

  it("says nothing about whose turn it is", async () => {
    const board = boardFixture();
    mountWith(
      [
        thread({ id: "t-theirs", authorId: THEM, authorName: "Maren", body: "Asked of you" }),
        thread({ id: "t-mine", authorId: ME, authorName: "Donavyn", body: "Asked by you" }),
      ],
      board,
    );
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
    mountWith(
      [
        thread({
          authorId: THEM,
          authorName: "Maren",
          body: "Deployed to dev; smoke tests green.",
          agentName: "Planning agent",
        } as Partial<DiscussionThread> & { body: string; authorId: string; authorName: string }),
      ],
      board,
    );
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
    await user.click(within(section()).getByRole("button", { name: "post" }));

    const posted = calls.find((call) => call.url.endsWith("/discussion"));
    expect(posted?.method).toBe("POST");
    expect(posted?.body).toEqual({ body: "Does this need a migration?" });
  });

  it("will not post an empty message", async () => {
    const board = boardFixture();
    const calls = mountWith([], board);
    const user = await openPage(board);

    const send = within(section()).getByRole("button", { name: "post" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Start a thread"), "   ");
    expect(send).toBeDisabled();
    expect(calls.filter((call) => call.url.endsWith("/discussion"))).toHaveLength(0);
  });

  it("commits with the same button the capture field uses, alive only once there is something to send", async () => {
    const board = boardFixture();
    mountWith([], board);
    const user = await openPage(board);

    const send = within(section()).getByRole("button", { name: "post" });
    // The same control the board's capture field carries, rather than a link dressed as one.
    expect(send.className).toContain("primary-button");
    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText("Start a thread"), "something");
    expect(send).toBeEnabled();
  });

  it("leaves the field the focus ring every other field in the product has", async () => {
    const board = boardFixture();
    mountWith([], board);
    await openPage(board);

    // Nothing of its own: the rules for `input, textarea` already say what a field does when
    // it is clicked, and this one used to draw a dimmer outline inside its own border.
    expect(document.querySelector(".composer-send")).toBeNull();
    expect(screen.getByLabelText("Start a thread").className).not.toContain("composer");
  });

  it("replies into the thread that was asked, not a new one", async () => {
    const board = boardFixture();
    const calls = mountWith(
      [thread({ id: "t-clock", authorId: THEM, authorName: "Maren", body: "Whose clock?" })],
      board,
    );
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
    const calls = mountWith(
      [thread({ id: "t-open", authorId: THEM, authorName: "Maren", body: "Whose clock?" })],
      board,
    );
    const user = await openPage(board);

    await user.click(within(section()).getByRole("button", { name: "answered" }));
    const posted = calls.find((call) => call.url.includes("/answered"));
    expect(posted?.url).toContain("/discussion/t-open/answered");
    expect(posted?.body).toEqual({ answered: true });
  });

  it("lights up your own name and leaves everyone else's quiet", async () => {
    const board = boardFixture();
    mountWith(
      [
        thread({
          authorId: THEM,
          authorName: "Maren",
          body: "@Donavyn can you take this? @Maren has Saturday.",
          mentions: [ME, THEM],
        } as Partial<DiscussionThread> & { body: string; authorId: string; authorName: string }),
      ],
      board,
    );
    await openPage(board);

    const marks = [...document.querySelectorAll(".mention")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["@Donavyn", "@Maren"]);
    // Yours is filled; somebody else's is only there so the sentence reads as addressed.
    expect(marks[0]!.className).toContain("you");
    expect(marks[1]!.className).not.toContain("you");
  });

  it("leaves a name nobody resolved as plain text", async () => {
    const board = boardFixture();
    mountWith(
      [thread({ authorId: THEM, authorName: "Maren", body: "@Nobody is on this project.", mentions: [] })],
      board,
    );
    await openPage(board);

    expect(document.querySelector(".mention")).toBeNull();
    expect(within(section()).getByText("@Nobody is on this project.")).toBeTruthy();
  });

  it("offers the people on the project once an @ is typed, and writes the one chosen", async () => {
    const board = boardFixture();
    const calls = mountWith([], board);
    const user = await openPage(board);

    const field = screen.getByLabelText("Start a thread");
    expect(document.querySelector(".mention-picker")).toBeNull();

    await user.type(field, "over to @Mar");
    const picker = document.querySelector(".mention-picker") as HTMLElement;
    expect(picker).toBeTruthy();
    expect(within(picker).getByRole("option", { name: /Maren/ })).toBeTruthy();

    // Enter belongs to the picker while it is open; it would otherwise post half a name.
    await user.keyboard("{Enter}");
    expect(calls.filter((call) => call.url.endsWith("/discussion"))).toHaveLength(0);
    expect((field as HTMLTextAreaElement).value).toBe("over to @Maren ");
    expect(document.querySelector(".mention-picker")).toBeNull();
  });

  it("closes the picker on escape without giving up what was typed", async () => {
    const board = boardFixture();
    mountWith([], board);
    const user = await openPage(board);

    const field = screen.getByLabelText("Start a thread");
    await user.type(field, "ask @Mar");
    expect(document.querySelector(".mention-picker")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(document.querySelector(".mention-picker")).toBeNull();
    expect((field as HTMLTextAreaElement).value).toBe("ask @Mar");
  });

  it("does not open the picker for an address", async () => {
    const board = boardFixture();
    mountWith([], board);
    const user = await openPage(board);

    await user.type(screen.getByLabelText("Start a thread"), "mail maren@example");
    expect(document.querySelector(".mention-picker")).toBeNull();
  });

  it("backs out of a reply without closing the page", async () => {
    const board = boardFixture();
    mountWith([thread({ id: "t-clock", authorId: THEM, authorName: "Maren", body: "Whose clock?" })], board);
    const user = await openPage(board);

    await user.click(within(section()).getByRole("button", { name: "reply" }));
    await user.type(screen.getByLabelText("Reply"), "Device time");
    await user.keyboard("{Escape}");

    // The drawer listens for Escape too; backing out of a reply is not closing the page.
    expect(screen.queryByRole("dialog", { name: "Edit page" })).toBeTruthy();
    expect(screen.queryByLabelText("Reply")).toBeNull();
  });

  it("closes the picker on escape without closing the page either", async () => {
    const board = boardFixture();
    mountWith([], board);
    const user = await openPage(board);

    await user.type(screen.getByLabelText("Start a thread"), "over to @Mar");
    expect(document.querySelector(".mention-picker")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(document.querySelector(".mention-picker")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit page" })).toBeTruthy();
  });

  it("does not reopen the picker on the space it just wrote", async () => {
    const board = boardFixture();
    const calls = mountWith([], board);
    const user = await openPage(board);

    const field = screen.getByLabelText("Start a thread") as HTMLTextAreaElement;
    await user.type(field, "over to @Mar");
    await user.keyboard("{Enter}");
    expect(field.value).toBe("over to @Maren ");
    // The trailing space still reads as a half-written name, and the picker must not take
    // the next Enter and mention somebody instead of sending.
    expect(document.querySelector(".mention-picker")).toBeNull();

    await user.keyboard("{Enter}");
    const posted = calls.find((call) => call.url.endsWith("/discussion"));
    expect(posted?.body).toEqual({ body: "over to @Maren" });
  });

  it("does not mark anything read while the conversation is still arriving", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 2;
    // Assigned synchronously by the executor, but the compiler cannot see that, so it starts
    // as a callable no-op rather than null.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The conversation never arrives until this test lets it.
    const { calls } = routeFetch({
      board,
      routes: { "GET /api/pages/": () => held.then(() => response({ threads: [] })) },
    });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByText(board.pages[1]!.title));
    await screen.findByRole("dialog", { name: "Edit page" });
    await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));

    // Asking to see a conversation is not reading one; a spinner is not a witness.
    expect(calls.filter((call) => call.url.includes("/discussion/seen"))).toHaveLength(0);
    release();
  });

  it("says a conversation could not be loaded rather than drawing an empty one", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 3;
    routeFetch({ board, routes: { "GET /api/pages/": () => Promise.reject(new Error("offline")) } });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByText(board.pages[1]!.title));
    await screen.findByRole("dialog", { name: "Edit page" });
    await user.click(within(aside()).getByRole("button", { name: /Discussion/ }));

    // Nothing drawn beside a badge saying three are unread would say the messages are gone.
    expect(await within(section()).findByText(/could not be loaded/)).toBeTruthy();
    expect(within(section()).queryByText("Nothing has been said here yet.")).toBeNull();
  });

  it("gives a screen reader a listbox that owns its options", async () => {
    const board = boardFixture();
    mountWith([], board);
    const user = await openPage(board);

    const field = screen.getByLabelText("Start a thread");
    await user.type(field, "over to @Mar");

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(field).toHaveAttribute("aria-expanded", "true");
    expect(field).toHaveAttribute("aria-controls", listbox.id);
    expect(field).toHaveAttribute("aria-activedescendant", options[0]!.id);
  });

  it("says on the switch when something unread named you", async () => {
    const board = boardFixture();
    board.pages[1]!.unseenMessages = 3;
    board.pages[1]!.unseenMentions = 1;
    mountWith([], board);
    await openPage(board, { discussion: false });

    const badge = document.querySelector(".discussion-unseen") as HTMLElement;
    // One badge, two states: the number is what is new, the accent is that it is about you.
    expect(badge.textContent).toBe("3");
    expect(badge.className).toContain("named");
    expect(within(aside()).getByLabelText("3 unread, 1 naming you")).toBeTruthy();

    cleanup();
    const quiet = boardFixture();
    quiet.pages[1]!.unseenMessages = 3;
    quiet.pages[1]!.unseenMentions = 0;
    mountWith([], quiet);
    await openPage(quiet, { discussion: false });
    expect((document.querySelector(".discussion-unseen") as HTMLElement).className).not.toContain("named");
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
    board.pages[1]!.openThreads = 2;
    board.pages[0]!.openThreads = 0;
    mountWith([], board);

    expect(await screen.findByTitle("2 open threads")).toBeTruthy();
    expect(screen.queryByTitle("0 open threads")).toBeNull();
  });

  it("says it in the singular for one", async () => {
    const board = boardFixture();
    board.pages[1]!.openThreads = 1;
    mountWith([], board);

    expect(await screen.findByTitle("1 open thread")).toBeTruthy();
  });
});
