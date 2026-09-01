// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentReview, AgentToken, AuditEvent } from "../../shared/types";
import { App } from "../../src/App";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, type RecordedCall, routeFetch } from "../fixtures/ui";

installUiHarness();

const PAGE_ID = "00000000-0000-4000-8000-000000000020";
const PAGE_TITLE = "Make the tower door remember Maren";

function agentEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sequence: 3,
    id: "agent-event-1",
    actorId: "00000000-0000-4000-8000-000000000010",
    actorName: "Donavyn",
    agentName: "Planning agent",
    agentTokenId: "token-1",
    entityType: "page",
    entityId: PAGE_ID,
    entityTitle: PAGE_TITLE,
    action: "updated",
    changes: [{ field: "column", from: "Backlog", to: "Up Next" }],
    createdAt: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

function credential(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    id: "token-1",
    name: "Planning agent",
    scope: "write",
    createdAt: "2026-08-13T00:00:00.000Z",
    lastUsedAt: "2026-08-30T09:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    ownerName: "Donavyn",
    ...overrides,
  };
}

function reviewFixture(overrides: Partial<AgentReview> = {}): AgentReview {
  return {
    since: 0,
    latest: 3,
    total: 1,
    events: [agentEvent()],
    waiting: [],
    credentials: [credential()],
    ...overrides,
  };
}

function mountWith(review: AgentReview, board = boardFixture()): RecordedCall[] {
  const { calls } = routeFetch({ board, routes: { "GET /api/agent-review": review } });
  render(<App />);
  return calls;
}

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /agents/ }));
  return screen.findByRole("dialog", { name: "Agent review" });
}

describe("the agent review", () => {
  it("offers itself from the top bar only while something needs reviewing", async () => {
    mountWith(reviewFixture());
    expect(await screen.findByRole("button", { name: /agents/ })).toBeInTheDocument();
  });

  it("stays out of the top bar when nothing is waiting", async () => {
    routeFetch();
    render(<App />);
    await screen.findByText("Model the potion workbench");
    expect(screen.queryByRole("button", { name: /agents/ })).toBeNull();
  });

  it("groups what agents did by page, with the agent named beside the person", async () => {
    const user = userEvent.setup();
    mountWith(reviewFixture());

    const dialog = await openReview(user);
    expect(within(dialog).getByRole("heading", { name: PAGE_TITLE })).toBeInTheDocument();
    const via = within(dialog).getByText(/via Planning agent/);
    expect(via.closest(".activity-line")?.textContent).toContain("Donavyn");
    expect(within(dialog).queryByText("Waiting on a person")).toBeNull();
  });

  it("lists an agent's open question as waiting on a person", async () => {
    const user = userEvent.setup();
    mountWith(
      reviewFixture({
        total: 0,
        events: [],
        waiting: [
          {
            id: "thread-1",
            pageId: PAGE_ID,
            pageTitle: PAGE_TITLE,
            agentName: "Planning agent",
            agentTokenId: "token-1",
            authorId: "00000000-0000-4000-8000-000000000010",
            authorName: "Donavyn",
            body: "Which door should this ward?",
            createdAt: "2026-08-30T09:05:00.000Z",
          },
        ],
      }),
    );

    const dialog = await openReview(user);
    expect(within(dialog).getByText("Waiting on a person")).toBeInTheDocument();
    expect(within(dialog).getByText("Which door should this ward?")).toBeInTheDocument();
  });

  it("revokes a credential in one tap, confirmed in place", async () => {
    const user = userEvent.setup();
    const calls = mountWith(reviewFixture());

    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole("button", { name: "revoke" }));
    await user.click(within(dialog).getByRole("button", { name: "yes" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/api/agent-tokens/token-1", method: "DELETE", body: {} }),
    );
  });

  it("shows a member the work but never the credential rail", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), viewerIsOwner: false };
    // The server omits credentials for a member; the interface must not invent the section.
    const membersReview = reviewFixture();
    delete membersReview.credentials;
    mountWith(membersReview, board);

    const dialog = await openReview(user);
    expect(within(dialog).getByText(/via Planning agent/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Credentials")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "revoke" })).toBeNull();
  });

  it("marks everything reviewed on close when everything was shown", async () => {
    const user = userEvent.setup();
    const calls = mountWith(reviewFixture());

    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole("button", { name: "Close agent review" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/api/agent-review/seen", method: "POST", body: {} }),
    );
  });

  it("marks only what it showed when the cap held some changes back", async () => {
    const user = userEvent.setup();
    const calls = mountWith(reviewFixture({ total: 5, latest: 9 }));

    const dialog = await openReview(user);
    expect(within(dialog).getByText(/4 more changes after these/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close agent review" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/agent-review/seen",
        method: "POST",
        body: { sequence: 3 },
      }),
    );
  });
});
