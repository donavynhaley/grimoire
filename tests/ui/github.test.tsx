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

function mountWith(board: BoardWorkspace, patchStatus = 200, pulls: unknown[] = []) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response(patchStatus === 200 ? { ok: true } : { error: "no" }, patchStatus);
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url === "/api/github/pulls") return response({ pulls });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
}

/** A project pointed at a repository, with nothing linked yet. */
function configuredBoard(): BoardWorkspace {
  const board = boardFixture();
  board.project.githubRepo = "wizards/simulator";
  return board;
}

function linkedBoard(): BoardWorkspace {
  const board = boardFixture();
  board.project.githubRepo = "wizards/simulator";
  board.pages[1] = {
    ...board.pages[1]!,
    github: { kind: "pr", number: 41 },
    githubStatus: {
      state: "open",
      prNumber: 41,
      prTitle: "Hold the circle",
      prUrl: "https://github.com/wizards/simulator/pull/41",
      checkedAt: "2026-08-18T12:00:00Z",
    },
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

describe("the connection check", () => {
  it("walks through setup and reports what the server found", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    board.project.githubRepo = "wizards/simulator";
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      const method = init.method ?? "GET";
      if (url === "/api/github/verify") {
        calls.push(url);
        return response({ ok: true, repo: "wizards/simulator", private: true });
      }
      if (method !== "GET") return response({ ok: true });
      if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
      if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
      if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
      if (url.startsWith("/api/session"))
        return response({ status: "authenticated", user: board.currentUser });
      return response(board);
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: "Project settings" }));
    await user.click(await screen.findByRole("button", { name: "GitHub" }));

    // A configured project gets its section back: the steps wait behind the question mark.
    expect(screen.queryByText(/create a fine-grained access token/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "How do I set this up?" }));
    expect(screen.getByText(/create a fine-grained access token/)).toBeInTheDocument();
    expect(screen.getByText(/Pull requests: read-only/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "check the connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connected: wizards/simulator (private repository).",
    );
    expect(calls).toEqual(["/api/github/verify"]);
  });
});

describe("the setup instructions", () => {
  it("open themselves for a project that has not been set up yet", async () => {
    const user = userEvent.setup();
    // boardFixture has no repository, which is exactly when the steps are worth reading.
    mountWith(boardFixture());

    await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
    await user.click(screen.getByRole("menuitem", { name: "Project settings" }));
    await user.click(await screen.findByRole("button", { name: "GitHub" }));

    expect(screen.getByText(/create a fine-grained access token/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide setup instructions" }));
    expect(screen.queryByText(/create a fine-grained access token/)).not.toBeInTheDocument();
  });
});

describe("a page's GitHub row", () => {
  it("links a pasted reference from the editor", async () => {
    const user = userEvent.setup();
    const board = configuredBoard();
    const calls = mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    await user.click(screen.getByRole("button", { name: /Not linked/ }));
    await user.type(screen.getByLabelText("Search pull requests, or type a branch"), "#41{Enter}");

    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: `/api/pages/${board.pages[1]!.id}`,
          method: "PATCH",
          body: { github: "#41" },
        }),
      ),
    );
  });

  it("offers the repository's open pull requests, narrowing as it is typed", async () => {
    const user = userEvent.setup();
    const board = configuredBoard();
    const calls = mountWith(board, 200, [
      {
        number: 21,
        title: "Rework the circle",
        url: "u21",
        state: "open",
        branch: "feat/circle",
        author: "maren",
      },
      {
        number: 20,
        title: "Half-finished idea",
        url: "u20",
        state: "draft",
        branch: "feat/idea",
        author: "mira",
      },
    ]);

    await user.click(await screen.findByText(board.pages[1]!.title));
    await user.click(screen.getByRole("button", { name: /Not linked/ }));

    // Both are offered before anything is typed, drafts marked as such.
    expect(await screen.findByRole("option", { name: /Link pull request 21/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Link pull request 20/ })).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search pull requests, or type a branch"), "circle");
    expect(screen.queryByRole("option", { name: /Link pull request 20/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Link pull request 21/ }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: `/api/pages/${board.pages[1]!.id}`,
          method: "PATCH",
          body: { github: "#21" },
        }),
      ),
    );
  });

  it("still takes a branch nobody suggested", async () => {
    const user = userEvent.setup();
    const board = configuredBoard();
    const calls = mountWith(board, 200, [
      {
        number: 21,
        title: "Rework the circle",
        url: "u21",
        state: "open",
        branch: "feat/circle",
        author: "maren",
      },
    ]);

    await user.click(await screen.findByText(board.pages[1]!.title));
    await user.click(screen.getByRole("button", { name: /Not linked/ }));
    await user.type(
      screen.getByLabelText("Search pull requests, or type a branch"),
      "feat/nothing-suggested",
    );
    // Nothing matches it, so it is offered as its own choice rather than second-guessed.
    await user.click(screen.getByRole("button", { name: /Use .*feat\/nothing-suggested.* as written/ }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: "PATCH", body: { github: "feat/nothing-suggested" } }),
      ),
    );
  });

  it("shows the linked pull request's state and unlinks with null", async () => {
    const user = userEvent.setup();
    const board = linkedBoard();
    const calls = mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    expect(screen.getByRole("link", { name: "open on GitHub ↗" })).toHaveAttribute(
      "href",
      "https://github.com/wizards/simulator/pull/41",
    );
    // The trigger says which pull request, how it stands, and what it is called.
    const trigger = screen.getByRole("button", { name: /#41/ });
    expect(trigger).toHaveTextContent("#41");
    expect(trigger).toHaveTextContent("open");
    expect(trigger).toHaveTextContent("Hold the circle");

    await user.click(screen.getByRole("button", { name: "Unlink from GitHub" }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: `/api/pages/${board.pages[1]!.id}`,
          method: "PATCH",
          body: { github: null },
        }),
      ),
    );
  });

  it("says plainly when the server refuses a reference", async () => {
    const user = userEvent.setup();
    const board = configuredBoard();
    mountWith(board, 400);

    await user.click(await screen.findByText(board.pages[1]!.title));
    await user.click(screen.getByRole("button", { name: /Not linked/ }));
    await user.type(screen.getByLabelText("Search pull requests, or type a branch"), "??{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Edit page" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/does not read as/);
  });
});

describe("a project with no repository", () => {
  it("shows no GitHub surface at all, rather than an empty one", async () => {
    const user = userEvent.setup();
    // boardFixture names no repository.
    const board = boardFixture();
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    expect(screen.getByRole("dialog", { name: "Edit page" })).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Not linked/ })).not.toBeInTheDocument();
  });

  it("still shows a link made before the repository was cleared, so it can be removed", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    board.pages[1] = {
      ...board.pages[1]!,
      github: { kind: "pr", number: 41 },
      githubStatus: { state: "open", prNumber: 41, prTitle: "Hold the circle", prUrl: "u", checkedAt: null },
    };
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    expect(screen.getByRole("button", { name: /#41/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink from GitHub" })).toBeInTheDocument();
  });
});

describe("what an unchecked link is called", () => {
  it("says a pull request is being checked, and only a branch has no PR yet", async () => {
    const user = userEvent.setup();
    const board = linkedBoard();
    // Freshly linked, before anything has been heard back about it.
    board.pages[1] = {
      ...board.pages[1]!,
      githubStatus: { state: "unchecked", prNumber: null, prTitle: null, prUrl: null, checkedAt: null },
    };
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    const trigger = screen.getByRole("button", { name: /#41/ });
    expect(trigger).toHaveTextContent("checking...");
    expect(trigger).not.toHaveTextContent("no PR yet");
  });

  it("says a branch has no pull request yet, because that is a place to sit for days", async () => {
    const user = userEvent.setup();
    const board = linkedBoard();
    board.pages[1] = {
      ...board.pages[1]!,
      github: { kind: "branch", name: "feat/rituals" },
      githubStatus: { state: "unchecked", prNumber: null, prTitle: null, prUrl: null, checkedAt: null },
    };
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1]!.title));
    expect(screen.getByRole("button", { name: /feat\/rituals/ })).toHaveTextContent("no PR yet");
  });
});

describe("the board card", () => {
  it("wears the pull request number and state", async () => {
    const board = linkedBoard();
    mountWith(board);

    const card = (await screen.findByText(board.pages[1]!.title)).closest("article")!;
    const pill = within(card).getByText("#41");
    expect(pill).toHaveClass("github-state-open");
  });

  it("wears the branch name while no pull request exists", async () => {
    const board = boardFixture();
    board.pages[1] = {
      ...board.pages[1]!,
      github: { kind: "branch", name: "feat/rituals" },
      githubStatus: { state: "unchecked", prNumber: null, prTitle: null, prUrl: null, checkedAt: null },
    };
    mountWith(board);

    const card = (await screen.findByText(board.pages[1]!.title)).closest("article")!;
    expect(within(card).getByText("⎇ feat/rituals")).toBeInTheDocument();
  });
});
