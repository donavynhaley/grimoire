// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AwayState, BoardWorkspace } from "../../shared/types";
import { App } from "../../src/App";
import { buildDigestLines } from "../../src/components/AwayDigest";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, type RecordedCall, routeFetch } from "../fixtures/ui";

installUiHarness();

/** Records every request, reads included, so tests can assert on cursor advances. */
function stubFetch(
  board: BoardWorkspace,
  options: { away?: AwayState; activity?: unknown } = {},
): RecordedCall[] {
  return routeFetch({
    board,
    record: "all",
    routes: {
      "GET /api/activity": options.activity ?? { events: [], hasMore: false },
      "GET /api/away": options.away ?? emptyAway(),
    },
  }).calls;
}

function emptyAway(): AwayState {
  return { since: 0, latest: 0, total: 0, events: [] };
}

function awayEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    sequence: 1,
    id: `event-${overrides.sequence ?? 1}`,
    actorId: "00000000-0000-4000-8000-000000000011",
    actorName: "Maren",
    agentName: null,
    agentTokenId: null,
    entityType: "page",
    entityId: "00000000-0000-4000-8000-000000000020",
    entityTitle: "Make the tower door remember Maren",
    action: "updated",
    changes: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

function memberView(board: BoardWorkspace): BoardWorkspace {
  const member = board.members[1]!;
  return {
    ...board,
    currentUser: { id: member.id, name: member.name, email: member.email, role: member.role },
    viewerIsOwner: false,
  };
}

describe("while you were away - quiet signals", () => {
  it("hides the activity control from members", async () => {
    const board = memberView(boardFixture());
    stubFetch(board);

    render(<App />);
    await screen.findByRole("button", { name: "team" });
    expect(screen.queryByRole("button", { name: /activity/ })).not.toBeInTheDocument();
  });

  it("shows the owner how much happened and clears the badge once the history is opened", async () => {
    const away: AwayState = { since: 5, latest: 19, total: 14, events: [awayEvent({ sequence: 6 })] };
    stubFetch(boardFixture(), { away });

    render(<App />);
    const badge = await screen.findByLabelText("14 changes since your last visit");
    expect(badge).toHaveTextContent("14");

    await userEvent.click(screen.getByRole("button", { name: /activity/ }));
    await screen.findByRole("dialog", { name: "Activity" });
    expect(screen.queryByLabelText("14 changes since your last visit")).not.toBeInTheDocument();
  });

  it("caps the badge at 99+", async () => {
    const away: AwayState = { since: 5, latest: 300, total: 240, events: [awayEvent({ sequence: 6 })] };
    stubFetch(boardFixture(), { away });

    render(<App />);
    expect(await screen.findByLabelText("240 changes since your last visit")).toHaveTextContent("99+");
  });

  it("draws the unread line where the last visit ended", async () => {
    const away: AwayState = {
      since: 5,
      latest: 8,
      total: 2,
      events: [awayEvent({ sequence: 7 }), awayEvent({ sequence: 8 })],
    };
    const activity = {
      events: [
        awayEvent({ sequence: 8, entityTitle: "Newest change" }),
        awayEvent({ sequence: 7, entityTitle: "Second new change" }),
        awayEvent({ sequence: 3, entityTitle: "Old seen change" }),
      ],
      hasMore: false,
    };
    stubFetch(boardFixture(), { away, activity });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /activity/ }));
    const dialog = await screen.findByRole("dialog", { name: "Activity" });

    const divider = await screen.findByRole("separator");
    expect(divider).toHaveTextContent("new since your last visit");
    const text = dialog.textContent ?? "";
    expect(text.indexOf("Second new change")).toBeLessThan(text.indexOf("new since your last visit"));
    expect(text.indexOf("new since your last visit")).toBeLessThan(text.indexOf("Old seen change"));
  });

  it("shows the digest, marks changed pages, and dismiss clears everything at once", async () => {
    const board = boardFixture();
    const changed = board.pages[1]!; // in progress, visible on the board
    const away: AwayState = {
      since: 5,
      latest: 8,
      total: 2,
      events: [
        awayEvent({
          sequence: 6,
          action: "updated",
          entityId: changed.id,
          entityTitle: changed.title,
          changes: [{ field: "notes", from: null, to: "sketch" }],
        }),
        awayEvent({
          sequence: 7,
          action: "moved",
          entityId: changed.id,
          entityTitle: changed.title,
          changes: [{ field: "column", from: "Up Next", to: "In progress" }],
        }),
      ],
    };
    stubFetch(board, { away });

    render(<App />);
    const digest = await screen.findByRole("region", { name: "While you were away" });
    expect(digest).toHaveTextContent("2 changes by Maren");
    expect(digest).toHaveTextContent(`started ${changed.title}`);

    const tile = screen.getByRole("button", {
      name: new RegExp(`Open ${changed.title}.*Changed while you were away`),
    });
    expect(tile.closest(".board-page")).toHaveClass("unseen");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss the away summary" }));
    expect(screen.queryByRole("region", { name: "While you were away" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Changed while you were away/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/changes since your last visit/)).not.toBeInTheDocument();
  });

  it("clears a page's dot as soon as the page is opened", async () => {
    const board = boardFixture();
    const changed = board.pages[1]!;
    const away: AwayState = {
      since: 5,
      latest: 7,
      total: 1,
      events: [
        awayEvent({
          sequence: 6,
          action: "updated",
          entityId: changed.id,
          entityTitle: changed.title,
          changes: [{ field: "notes", from: null, to: "x" }],
        }),
      ],
    };
    stubFetch(board, { away });

    render(<App />);
    const tile = await screen.findByRole("button", { name: /Changed while you were away/ });
    await userEvent.click(tile);
    await screen.findByRole("dialog", { name: "Edit page" });
    await userEvent.click(screen.getByRole("button", { name: "Close page" }));

    expect(screen.queryByRole("button", { name: /Changed while you were away/ })).not.toBeInTheDocument();
    // The digest itself stays until dismissed; only the answered dot retires.
    expect(screen.getByRole("region", { name: "While you were away" })).toBeInTheDocument();
  });

  it("keeps the digest to five lines and expands in place", async () => {
    const board = boardFixture();
    const events = Array.from({ length: 8 }, (_, index) =>
      awayEvent({
        sequence: 10 + index,
        action: "created",
        entityId: `00000000-0000-4000-8000-0000000001${index}0`.slice(0, 36),
        entityTitle: `Fresh page ${index}`,
        actorId:
          index % 2 === 0 ? "00000000-0000-4000-8000-000000000011" : "00000000-0000-4000-8000-000000000012",
        actorName: index % 2 === 0 ? "Maren" : "Sam",
        changes: [{ field: "column", from: null, to: index % 4 < 2 ? "Up Next" : "Review" }],
      }),
    );
    // Four distinct actor-column runs plus idea and team news makes seven lines.
    events.push(
      awayEvent({
        sequence: 30,
        entityType: "idea",
        entityId: "00000000-0000-4000-8000-000000000040",
        entityTitle: "Rune spells",
        action: "moved",
        changes: [{ field: "list", from: "Idea inbox", to: "Shortlist" }],
      }),
    );
    events.push(
      awayEvent({
        sequence: 31,
        entityType: "idea",
        entityId: "00000000-0000-4000-8000-000000000041",
        entityTitle: "Tower garden",
        action: "created",
      }),
    );
    events.push(
      awayEvent({
        sequence: 32,
        entityType: "member",
        entityId: "00000000-0000-4000-8000-000000000013",
        entityTitle: "Alex",
        action: "joined",
        actorName: "Alex",
      }),
    );
    const away: AwayState = { since: 5, latest: 40, total: events.length, events };
    stubFetch(board, { away });

    render(<App />);
    const digest = await screen.findByRole("region", { name: "While you were away" });
    expect(digest.querySelectorAll(".away-line")).toHaveLength(5);

    await userEvent.click(screen.getByRole("button", { name: /more change/ }));
    expect(digest.querySelectorAll(".away-line").length).toBeGreaterThan(5);
    expect(digest).toHaveTextContent("joined the project");
  });

  it("advances the seen cursor on load only while the tab is visible", async () => {
    const board = boardFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const calls = stubFetch(board, {
      away: { since: 5, latest: 9, total: 1, events: [awayEvent({ sequence: 6 })] },
    });

    render(<App />);
    await waitFor(() => expect(calls.some((call) => call.url.startsWith("/api/away"))).toBe(true));
    expect(calls.some((call) => call.url.startsWith("/api/seen"))).toBe(false);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(calls.some((call) => call.url.startsWith("/api/seen") && call.method === "POST")).toBe(true),
    );
  });
});

describe("buildDigestLines", () => {
  function digest(events: AuditEvent[], board = boardFixture()) {
    return buildDigestLines({ since: 0, latest: 100, total: events.length, events }, board);
  }
  function lineText(line: { actorName: string; parts: Array<{ text: string }> }): string {
    return `${line.actorName} ${line.parts.map((part) => part.text).join("")}`;
  }

  it("puts assignments to the reader first and tags them", () => {
    const lines = digest([
      awayEvent({
        sequence: 1,
        action: "moved",
        entityTitle: "Other work",
        changes: [{ field: "column", from: "Review", to: "Done" }],
      }),
      awayEvent({
        sequence: 2,
        action: "updated",
        entityTitle: "Model the door",
        changes: [{ field: "assignee", from: "unassigned", to: "Donavyn" }],
      }),
    ]);
    expect(lineText(lines[0]!)).toBe("Maren assigned you Model the door");
    expect(lines[0]!.aboutYou).toBe(true);
    expect(lineText(lines[1]!)).toBe("Maren finished Other work");
    expect(lines[1]!.aboutYou).toBe(false);
  });

  it("links a finished blocker to the reader's blocked page", () => {
    const board = boardFixture();
    const blocker = board.pages[0]!;
    board.pages[1] = {
      ...board.pages[1]!,
      assigneeId: board.currentUser.id,
      assigneeName: "Donavyn",
      blockedBy: [blocker.id],
    };
    const lines = digest(
      [
        awayEvent({
          sequence: 1,
          action: "moved",
          entityId: blocker.id,
          entityTitle: blocker.title,
          changes: [{ field: "column", from: "In progress", to: "Done" }],
        }),
      ],
      board,
    );
    expect(lineText(lines[0]!)).toBe(
      `Maren finished ${blocker.title} - your ${board.pages[1]!.title} is no longer blocked`,
    );
    expect(lines[0]!.tier).toBe(1);
  });

  it("groups a same-actor run of new pages into one line", () => {
    const lines = digest([
      awayEvent({
        sequence: 1,
        action: "created",
        entityId: "00000000-0000-4000-8000-000000000050",
        entityTitle: "First page",
        changes: [{ field: "column", from: null, to: "Up Next" }],
      }),
      awayEvent({
        sequence: 2,
        action: "created",
        entityId: "00000000-0000-4000-8000-000000000051",
        entityTitle: "Second page",
        changes: [{ field: "column", from: null, to: "Up Next" }],
      }),
      awayEvent({
        sequence: 3,
        action: "created",
        entityId: "00000000-0000-4000-8000-000000000052",
        entityTitle: "Third page",
        changes: [{ field: "column", from: null, to: "Up Next" }],
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lineText(lines[0]!)).toBe("Maren added First page and 2 more pages to Up Next");
  });

  it("collapses repeat edits and speaks each idea change in its own words", () => {
    const lines = digest([
      awayEvent({
        sequence: 1,
        action: "updated",
        entityTitle: "Potion bench",
        changes: [{ field: "notes", from: null, to: "a" }],
      }),
      awayEvent({
        sequence: 2,
        action: "updated",
        entityTitle: "Potion bench",
        changes: [{ field: "notes", from: "a", to: "b" }],
      }),
      awayEvent({
        sequence: 3,
        entityType: "idea",
        entityId: "00000000-0000-4000-8000-000000000040",
        entityTitle: "Rune spells",
        action: "moved",
        changes: [{ field: "list", from: "Idea inbox", to: "Shortlist" }],
      }),
      awayEvent({
        sequence: 4,
        entityType: "idea",
        entityId: "00000000-0000-4000-8000-000000000041",
        entityTitle: "Tower garden",
        action: "promoted",
        changes: [{ field: "became a page", from: null, to: "Tower garden" }],
      }),
    ]);
    expect(lines.map(lineText)).toEqual([
      "Maren edited Potion bench",
      "Maren shortlisted Rune spells",
      "Maren promoted Tower garden into the Backlog",
    ]);
  });

  it("skips the page creation a promotion already covers, and invitation links entirely", () => {
    const lines = digest([
      awayEvent({
        sequence: 1,
        action: "created",
        entityTitle: "Tower garden",
        changes: [{ field: "promoted from an idea", from: null, to: "Tower garden" }],
      }),
      awayEvent({
        sequence: 2,
        entityType: "member",
        entityId: null,
        entityTitle: "invitation link",
        action: "invited",
      }),
    ]);
    expect(lines).toHaveLength(0);
  });
});
