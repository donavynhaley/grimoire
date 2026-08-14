// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { AgentToken, BoardWorkspace } from "../../shared/types";
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
};

/** Mounts the app and records the agent-token calls the dialog makes. */
function mountWith({ tokens = [], board = boardFixture() }: Options = {}) {
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
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
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
  const settings = await screen.findByRole("dialog", { name: "Wizard Simulator" });
  await user.click(within(settings).getByRole("button", { name: /manage/ , hidden: false }));
  return screen.findByRole("dialog", { name: "Agent access" });
}

describe("agent access", () => {
  it("offers the section from project settings", async () => {
    const user = userEvent.setup();
    mountWith();

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));

    const settings = await screen.findByRole("dialog", { name: "Wizard Simulator" });
    expect(within(settings).getByText("Agent access")).toBeInTheDocument();
    expect(within(settings).getByText(/can never archive or promote/)).toBeInTheDocument();
  });

  it("shows a newly issued secret once, and says it will not be shown again", async () => {
    const user = userEvent.setup();
    mountWith();

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Wizard Simulator" });
    const [manage] = within(settings).getAllByRole("button", { name: /manage/ });
    await user.click(manage);

    const dialog = await screen.findByRole("dialog", { name: "Agent access" });
    await user.type(within(dialog).getByLabelText("Agent name"), "Planning agent");
    await user.click(within(dialog).getByRole("button", { name: "issue" }));

    expect(await within(dialog).findByText("grim_a-very-secret-value")).toBeInTheDocument();
    expect(within(dialog).getByText(/only time it is shown/i)).toBeInTheDocument();
  });

  it("lists an agent with the person it acts as", async () => {
    const user = userEvent.setup();
    mountWith({ tokens: [token({ lastUsedAt: null })] });

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Wizard Simulator" });
    const [manage] = within(settings).getAllByRole("button", { name: /manage/ });
    await user.click(manage);

    const dialog = await screen.findByRole("dialog", { name: "Agent access" });
    expect(await within(dialog).findByText("Planning agent")).toBeInTheDocument();
    expect(within(dialog).getByText(/acts as Donavyn/)).toBeInTheDocument();
    expect(within(dialog).getByText(/never used/)).toBeInTheDocument();
  });

  it("confirms before revoking, and says past work keeps its attribution", async () => {
    const user = userEvent.setup();
    const calls = mountWith({ tokens: [token()] });

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Wizard Simulator" });
    const [manage] = within(settings).getAllByRole("button", { name: /manage/ });
    await user.click(manage);

    const dialog = await screen.findByRole("dialog", { name: "Agent access" });
    await within(dialog).findByText("Planning agent");
    await user.click(within(dialog).getByRole("button", { name: "revoke" }));

    // Nothing has been sent yet - the confirm is a real gate.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "yes" }));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(await within(dialog).findByText(/still says which agent wrote it/)).toBeInTheDocument();
  });

  it("is unreachable for a member, who never gets project settings at all", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith({
      board: {
        ...board,
        currentUser: { ...board.currentUser, role: "member" },
        // A second project so the switcher renders for a member at all; with one project
        // there is no menu to open.
        projects: [...board.projects, { id: "project-2", name: "Second project" }],
      },
    });

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    const menu = screen.getByRole("menu", { name: "Projects" });

    // Issuing a credential is the owner's decision, and the whole settings surface that
    // would lead there is owner-only, so there is nothing for a member to reach.
    expect(within(menu).queryByRole("menuitem", { name: /Project settings/ })).toBeNull();
    expect(screen.queryByText("Agent access")).toBeNull();
  });
});
