// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, Chapter } from "../../shared/types";
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

const closedChapter: Chapter = {
  slug: "sprint-one",
  name: "Sprint One",
  description: "",
  state: "closed",
  position: 0,
  startsOn: null,
  endsOn: null,
  createdById: "u1",
  createdByName: "Maren",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  closedAt: "2026-08-10T00:00:00.000Z",
  carriedPages: 2,
  carriedEstimate: 5,
  carriedTo: null,
  deliveredPages: 7,
  deliveredEstimate: 21,
};

function configured(): BoardWorkspace {
  const board = boardFixture();
  board.project.chaptersEnabled = true;
  board.project.discordWebhookSet = true;
  board.chapters = [closedChapter];
  return board;
}

function mountWith(board: BoardWorkspace, postStatus = 200) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response(postStatus === 200 ? { sent: 2, failed: 0 } : { error: "no" }, postStatus);
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
}

async function openDiscord(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
  await user.click(screen.getByRole("menuitem", { name: "Project settings" }));
  await user.click(await screen.findByRole("button", { name: "Discord" }));
}

describe("the Discord recap settings", () => {
  it("saves a webhook without ever reading one back", async () => {
    const user = userEvent.setup();
    const calls = mountWith(boardFixture());
    await openDiscord(user);

    const field = screen.getByLabelText("Webhook URL");
    expect(field).toHaveAttribute("type", "password");
    await user.type(field, "https://discord.com/api/webhooks/secret");
    await user.tab();

    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "PATCH",
          body: { discordWebhook: "https://discord.com/api/webhooks/secret" },
        }),
      ),
    );
    // The field forgets what it sent the moment it sends it.
    expect(field).toHaveValue("");
  });

  it("opens its instructions for a project that has not set one up", async () => {
    const user = userEvent.setup();
    mountWith(boardFixture());
    await openDiscord(user);
    expect(screen.getByText(/Server Settings/)).toBeInTheDocument();
  });

  it("turns the automation on and off", async () => {
    const user = userEvent.setup();
    const calls = mountWith(configured());
    await openDiscord(user);

    await user.click(screen.getByLabelText("Post on close"));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: "PATCH", body: { recapOnClose: false } }),
      ),
    );
  });

  it("will not offer the automation to a project with nowhere to post", async () => {
    const user = userEvent.setup();
    mountWith(boardFixture());
    await openDiscord(user);
    expect(screen.getByLabelText("Post on close")).toBeDisabled();
  });

  it("posts a closed chapter's recap by hand, and says when Discord refused", async () => {
    const user = userEvent.setup();
    const calls = mountWith(configured());
    await openDiscord(user);

    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    await user.click(within(dialog).getByRole("button", { name: "Sprint One" }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ url: "/api/chapters/sprint-one/recap", method: "POST" }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Posted the recap for Sprint One.");
  });

  it("says plainly when the post fails", async () => {
    const user = userEvent.setup();
    mountWith(configured(), 400);
    await openDiscord(user);

    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    await user.click(within(dialog).getByRole("button", { name: "Sprint One" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/would not take the post/);
  });
});
