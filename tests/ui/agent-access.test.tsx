// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { AgentToken, AuditEvent, AwayState, BoardWorkspace } from "../../shared/types";
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

function token(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    id: "token-1",
    name: "Planning agent",
    scope: "write",
    createdAt: "2026-08-13T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ownerName: "Donavyn",
    ...overrides,
  };
}

type Options = {
  tokens?: AgentToken[];
  board?: BoardWorkspace;
  activity?: AuditEvent[];
  away?: AwayState;
};

/** Mounts the app and records the agent-token calls the dialog makes. */
function mountWith({ tokens = [], board = boardFixture(), activity = [], away }: Options = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let stored = [...tokens];

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (url.startsWith("/api/agent-tokens")) {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST") {
        const created = token({ id: "token-new", name: JSON.parse(String(init.body)).name });
        stored = [...stored, created];
        return response({ token: created, secret: "grim_a-very-secret-value" }, 201);
      }
      if (method === "DELETE") {
        stored = stored.map((candidate) =>
          url.endsWith(candidate.id) ? { ...candidate, revokedAt: "2026-08-14T00:00:00.000Z" } : candidate,
        );
        return response({ ok: true });
      }
      return response({ tokens: stored });
    }
    if (url.startsWith("/api/activity")) return response({ events: activity, hasMore: false });
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response(away ?? { since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/seen")) return response({ ok: true });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });

  render(<App />);
  return calls;
}

async function openAgentAccess(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
  await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
  const settings = await screen.findByRole("dialog", { name: "Project settings" });
  await user.click(within(settings).getByRole("button", { name: "Agent access" }));
  return settings;
}

describe("agent access", () => {
  it("offers the section from project settings", async () => {
    const user = userEvent.setup();
    mountWith();

    const settings = await openAgentAccess(user);
    expect(within(settings).getByText(/can never archive, promote/)).toBeInTheDocument();
  });

  it("shows a newly issued secret once, and says it will not be shown again", async () => {
    const user = userEvent.setup();
    mountWith();

    const dialog = await openAgentAccess(user);
    await user.type(within(dialog).getByLabelText("Agent name"), "Planning agent");
    await user.click(within(dialog).getByRole("button", { name: "issue" }));

    expect(await within(dialog).findByText("grim_a-very-secret-value")).toBeInTheDocument();
    expect(within(dialog).getByText(/only time it is shown/i)).toBeInTheDocument();
  });

  it("lists an agent with the person it acts as", async () => {
    const user = userEvent.setup();
    mountWith({ tokens: [token({ lastUsedAt: null })] });

    const dialog = await openAgentAccess(user);
    expect(await within(dialog).findByText("Planning agent")).toBeInTheDocument();
    expect(within(dialog).getByText(/acts as Donavyn/)).toBeInTheDocument();
    expect(within(dialog).getByText(/never used/)).toBeInTheDocument();
  });

  it("confirms before revoking, and says past work keeps its attribution", async () => {
    const user = userEvent.setup();
    const calls = mountWith({ tokens: [token()] });

    const dialog = await openAgentAccess(user);
    await within(dialog).findByText("Planning agent");
    await user.click(within(dialog).getByRole("button", { name: "revoke" }));

    // Nothing has been sent yet - the confirm is a real gate.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "yes" }));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(await within(dialog).findByText(/still says which agent wrote it/)).toBeInTheDocument();
  });

  it("is absent for a member, whose settings read the project without reshaping it", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith({
      board: {
        ...board,
        currentUser: { ...board.currentUser, role: "member" },
        // Owning the project is what draws the owner surfaces, not the account beside it.
        viewerIsOwner: false,
        members: board.members.map((member) =>
          member.id === board.currentUser.id ? { ...member, role: "member" as const, projectRole: "member" as const } : member,
        ),
      },
    });

    // A member gets the settings surface now - reading what the project is shaped like is
    // not reshaping it - but issuing a credential stays the owner's decision.
    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Project settings" });

    expect(within(settings).getByRole("button", { name: "Team" })).toBeInTheDocument();
    expect(within(settings).queryByRole("button", { name: "Agent access" })).toBeNull();
    expect(within(settings).queryByRole("button", { name: "Danger zone" })).toBeNull();
  });
  it("names the agent beside the person in the activity log", async () => {
    const user = userEvent.setup();
    mountWith({
      activity: [
        {
          sequence: 1,
          id: "event-1",
          actorId: boardFixture().currentUser.id,
          actorName: "Donavyn",
          agentName: "Planning agent",
          entityType: "page",
          entityId: null,
          entityTitle: "Ward the tower door",
          action: "created",
          changes: [],
          createdAt: "2026-08-13T10:00:00.000Z",
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: /activity/ }));
    const dialog = await screen.findByRole("dialog", { name: /activity/i });
    // A machine write must be tellable from the person's own, with the person still named.
    const via = await within(dialog).findByText(/via Planning agent/);
    expect(via.closest(".activity-line")?.textContent).toContain("Donavyn");
  });

  it("names the agent in the while-you-were-away digest", async () => {
    const board = boardFixture();
    mountWith({
      board,
      away: {
        since: 0,
        latest: 2,
        total: 1,
        events: [
          {
            sequence: 2,
            id: "away-1",
            // A teammate's agent, so the line is not excluded as the reader's own action.
            actorId: board.members[1].id,
            actorName: "Maren",
            agentName: "Night gardener",
            entityType: "page",
            entityId: board.pages[0]?.id ?? null,
            entityTitle: "Quietly drafted overnight",
            action: "created",
            changes: [{ field: "column", from: null, to: "Backlog" }],
            createdAt: "2026-08-13T02:00:00.000Z",
          },
        ],
      },
    });

    expect(await screen.findByText(/via Night gardener/)).toBeInTheDocument();
  });

  it("counts an expired credential as retired, not live", async () => {
    const user = userEvent.setup();
    mountWith({
      tokens: [token({ id: "expired-1", name: "Old agent", expiresAt: "2020-01-01T00:00:00.000Z" })],
    });

    const dialog = await openAgentAccess(user);
    // The server refuses it exactly like a revoked one, so listing it live would offer a
    // revoke button on a thing that already stopped.
    expect(await within(dialog).findByText(/No agent has access/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 revoked or expired/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "revoke" })).toBeNull();
  });

  it("says when the agent list could not be loaded instead of claiming nobody has access", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/agent-tokens")) return response({ error: "boom" }, 500);
      if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
      if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
      if (url.startsWith("/api/seen")) return response({ ok: true });
      if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
      return response(board);
    });
    render(<App />);

    const dialog = await openAgentAccess(user);
    // A failed fetch used to read as an authoritative "0 agents". The failure is now named.
    expect(await within(dialog).findByText(/could not be loaded/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/No agent has access/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "retry" })).toBeInTheDocument();
  });
});
