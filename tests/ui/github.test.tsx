// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace } from "../../shared/types";
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

function mountWith(board: BoardWorkspace, patchStatus = 200) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response(patchStatus === 200 ? { ok: true } : { error: "no" }, patchStatus);
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
}

function linkedBoard(): BoardWorkspace {
  const board = boardFixture();
  board.project.githubRepo = "wizards/simulator";
  board.pages[1] = {
    ...board.pages[1],
    github: { kind: "pr", number: 41 },
    githubStatus: { state: "open", prNumber: 41, prTitle: "Hold the circle", prUrl: "https://github.com/wizards/simulator/pull/41", checkedAt: "2026-08-18T12:00:00Z" },
  };
  return board;
}

describe("the GitHub settings section", () => {
  it("saves the repository and sends a token without ever reading one back", async () => {
    const user = userEvent.setup();
    const calls = mountWith(boardFixture());

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: "Project settings" }));
    await user.click(await screen.findByRole("button", { name: "GitHub" }));

    await user.type(screen.getByLabelText("Repository"), "wizards/simulator");
    await user.tab();
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: "PATCH", body: { githubRepo: "wizards/simulator" } }),
      ),
    );

    const token = screen.getByLabelText("Access token");
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "github_pat_abc");
    await user.tab();
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: "PATCH", body: { githubToken: "github_pat_abc" } }),
      ),
    );
    // The field forgets what it sent the moment it sends it.
    expect(token).toHaveValue("");
  });
});

describe("a page's GitHub row", () => {
  it("links a pasted reference from the editor", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    const calls = mountWith(board);

    await user.click(await screen.findByText(board.pages[1].title));
    await user.click(screen.getByRole("button", { name: "Link a pull request or branch" }));
    await user.type(screen.getByLabelText("Pull request or branch"), "#41{Enter}");

    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: `/api/pages/${board.pages[1].id}`,
          method: "PATCH",
          body: { github: "#41" },
        }),
      ),
    );
  });

  it("shows the linked pull request's state and unlinks with null", async () => {
    const user = userEvent.setup();
    const board = linkedBoard();
    const calls = mountWith(board);

    await user.click(await screen.findByText(board.pages[1].title));
    const link = screen.getByRole("link", { name: "PR #41" });
    expect(link).toHaveAttribute("href", "https://github.com/wizards/simulator/pull/41");
    expect(screen.getByText("open")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unlink from GitHub" }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: `/api/pages/${board.pages[1].id}`,
          method: "PATCH",
          body: { github: null },
        }),
      ),
    );
  });

  it("says plainly when the server refuses a reference", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith(board, 400);

    await user.click(await screen.findByText(board.pages[1].title));
    await user.click(screen.getByRole("button", { name: "Link a pull request or branch" }));
    await user.type(screen.getByLabelText("Pull request or branch"), "??{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Edit page" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/does not read as/);
  });
});

describe("the board card", () => {
  it("wears the pull request number and state", async () => {
    const board = linkedBoard();
    mountWith(board);

    const card = (await screen.findByText(board.pages[1].title)).closest("article")!;
    const pill = within(card).getByText("#41");
    expect(pill).toHaveClass("github-state-open");
  });

  it("wears the branch name while no pull request exists", async () => {
    const board = boardFixture();
    board.pages[1] = {
      ...board.pages[1],
      github: { kind: "branch", name: "feat/rituals" },
      githubStatus: { state: "unchecked", prNumber: null, prTitle: null, prUrl: null, checkedAt: null },
    };
    mountWith(board);

    const card = (await screen.findByText(board.pages[1].title)).closest("article")!;
    expect(within(card).getByText("⎇ feat/rituals")).toBeInTheDocument();
  });
});
