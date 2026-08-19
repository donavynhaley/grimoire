import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page } from "../../shared/types";
import { parseGithubReference } from "../../server/github";
import { bootstrap, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

/**
 * A GitHub that answers from a script.
 *
 * Keys are `owner/repo#number` for pull requests and `owner/repo@branch` for head lookups;
 * values are what the API would say. Every asked path is recorded, including the token that
 * asked it, so a test can hold the client to what it sent.
 */
function fakeGithub(answers: Record<string, unknown>) {
  const asked: Array<{ path: string; token: string }> = [];
  const fetcher = async (path: string, token: string) => {
    asked.push({ path, token });
    const pull = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (pull) {
      const answer = answers[`${pull[1]}#${pull[2]}`];
      return answer ? { status: 200, body: answer } : { status: 404, body: null };
    }
    const repoOnly = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repoOnly) {
      const answer = answers[`repo:${repoOnly[1]}`];
      if (answer === "unauthorized") return { status: 401, body: { message: "Bad credentials" } };
      return answer ? { status: 200, body: answer } : { status: 404, body: null };
    }
    const openList = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\?state=open&/);
    if (openList) {
      const answer = answers[`open:${openList[1]}`];
      return { status: 200, body: Array.isArray(answer) ? answer : [] };
    }
    const head = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\?head=([^&]+)&/);
    if (head) {
      const branch = decodeURIComponent(head[2]).split(":")[1];
      const answer = answers[`${head[1]}@${branch}`];
      return { status: 200, body: answer ? [answer] : [] };
    }
    return { status: 404, body: null };
  };
  return { fetcher, asked };
}

async function configureRepo(server: TestServer, projectId: string, token = "") {
  return server.request(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ githubRepo: "wizards/simulator", githubToken: token }),
  });
}

async function board(server: TestServer): Promise<BoardWorkspace> {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

async function makePage(server: TestServer, title: string, status = "in_progress"): Promise<Page> {
  const { body } = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title, status }),
  });
  return body.page;
}

async function link(server: TestServer, pageId: string, reference: string) {
  return server.request<{ page: Page }>(`/api/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ github: reference }),
  });
}

async function refresh(server: TestServer) {
  return server.request("/api/github/refresh", { method: "POST", body: "{}" });
}

describe("reading a pasted reference", () => {
  it("understands PR URLs, numbers, branch URLs, and bare branches", () => {
    expect(parseGithubReference("https://github.com/o/r/pull/41", "o/r")).toEqual({ kind: "pr", number: 41 });
    expect(parseGithubReference("#41", "o/r")).toEqual({ kind: "pr", number: 41 });
    expect(parseGithubReference("41", "o/r")).toEqual({ kind: "pr", number: 41 });
    expect(parseGithubReference("feat/rituals", "o/r")).toEqual({ kind: "branch", name: "feat/rituals" });
    expect(parseGithubReference("https://github.com/o/r/tree/feat/rituals", "o/r")).toEqual({ kind: "branch", name: "feat/rituals" });
  });

  it("keeps a repository that differs from the project's, and drops one that matches", () => {
    expect(parseGithubReference("https://github.com/other/repo/pull/7", "o/r")).toEqual({ kind: "pr", number: 7, repo: "other/repo" });
    expect(parseGithubReference("https://github.com/o/r/pull/7", "o/r")).toEqual({ kind: "pr", number: 7 });
  });

  it("refuses bare references when the project has no repository to hang them on", () => {
    expect(parseGithubReference("#41", "")).toBeNull();
    expect(parseGithubReference("feat/rituals", "")).toBeNull();
    expect(parseGithubReference("https://github.com/o/r/pull/41", "")).toEqual({ kind: "pr", number: 41, repo: "o/r" });
  });
});

describe("the board following the code", () => {
  it("stores the project repository, keeps the token server-side, and links a page", async () => {
    const github = fakeGithub({
      "wizards/simulator#12": { number: 12, title: "Hold the circle", html_url: "https://github.com/wizards/simulator/pull/12", state: "open", draft: false, merged_at: null },
    });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id, "ghp_secret");

    const page = await makePage(server, "Hold the circle");
    await link(server, page.id, "#12");

    const after = await board(server);
    expect(after.project.githubRepo).toBe("wizards/simulator");
    expect(after.project.githubTokenSet).toBe(true);
    // The token never rides any payload the browser sees...
    expect(JSON.stringify(after)).not.toContain("ghp_secret");
    // ...but it authenticates every question the server asks.
    expect(github.asked.every((call) => call.token === "ghp_secret")).toBe(true);

    const linked = after.pages.find((candidate) => candidate.id === page.id)!;
    expect(linked.github).toEqual({ kind: "pr", number: 12 });
    expect(linked.githubStatus?.state).toBe("open");
    expect(linked.githubStatus?.prTitle).toBe("Hold the circle");
  });

  it("moves a page with an open pull request into Review, and never backwards", async () => {
    const github = fakeGithub({
      "wizards/simulator#12": { number: 12, title: "t", html_url: "u", state: "open", draft: false, merged_at: null },
    });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);

    const page = await makePage(server, "In progress work", "in_progress");
    await link(server, page.id, "#12");
    let current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("review");

    // A hand pulls it back; the robot leaves it there.
    await server.request(`/api/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress", position: 0 }) });
    await refresh(server);
    current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("in_progress");
  });

  it("moves a merged pull request's page into Done and audits it as GitHub", async () => {
    const merged = { number: 12, title: "t", html_url: "u", state: "closed", draft: false, merged_at: "2026-08-18T12:00:00Z" };
    const github = fakeGithub({ "wizards/simulator#12": merged });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);

    const page = await makePage(server, "Nearly done work", "review");
    await link(server, page.id, "#12");

    const current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("done");
    expect(current.completedAt).not.toBeNull();
    expect(current.githubStatus?.state).toBe("merged");

    const activity = await server.request<{ events: Array<{ actorName: string; action: string; changes: Array<{ field: string; to: string | null }> }> }>(
      "/api/activity?limit=10",
    );
    const moved = activity.body.events.find((event) => event.actorName === "GitHub");
    expect(moved).toBeDefined();
    expect(moved!.action).toBe("moved");
    expect(moved!.changes).toContainEqual(expect.objectContaining({ field: "column", to: "Done" }));
  });

  it("adopts the pull request a linked branch grows, then follows it to Done", async () => {
    const answers: Record<string, unknown> = {};
    const github = fakeGithub(answers);
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);

    const page = await makePage(server, "Branch-first work", "in_progress");
    await link(server, page.id, "feat/rituals");

    // No PR yet: the link waits politely and the page does not move.
    let current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("in_progress");
    expect(current.githubStatus?.state).toBe("unchecked");

    // A PR appears from that branch.
    answers["wizards/simulator@feat/rituals"] = { number: 77, title: "Rituals", html_url: "u77", state: "open", draft: false, merged_at: null };
    await refresh(server);
    current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("review");
    expect(current.githubStatus?.prNumber).toBe(77);

    // And merges.
    answers["wizards/simulator@feat/rituals"] = { number: 77, title: "Rituals", html_url: "u77", state: "closed", draft: false, merged_at: "2026-08-18T12:00:00Z" };
    await refresh(server);
    current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.status).toBe("done");
  });

  it("leaves draft and closed-unmerged pull requests where the hand put them", async () => {
    const github = fakeGithub({
      "wizards/simulator#1": { number: 1, title: "draft", html_url: "u", state: "open", draft: true, merged_at: null },
      "wizards/simulator#2": { number: 2, title: "closed", html_url: "u", state: "closed", draft: false, merged_at: null },
    });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);

    const drafted = await makePage(server, "Draft work", "in_progress");
    const abandoned = await makePage(server, "Abandoned work", "in_progress");
    await link(server, drafted.id, "#1");
    await link(server, abandoned.id, "#2");

    const after = await board(server);
    expect(after.pages.find((candidate) => candidate.id === drafted.id)!.status).toBe("in_progress");
    expect(after.pages.find((candidate) => candidate.id === drafted.id)!.githubStatus?.state).toBe("draft");
    expect(after.pages.find((candidate) => candidate.id === abandoned.id)!.status).toBe("in_progress");
    expect(after.pages.find((candidate) => candidate.id === abandoned.id)!.githubStatus?.state).toBe("closed");
  });

  it("unlinks cleanly and refuses an unreadable reference", async () => {
    const github = fakeGithub({
      "wizards/simulator#12": { number: 12, title: "t", html_url: "u", state: "open", draft: false, merged_at: null },
    });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);
    const page = await makePage(server, "Some work", "backlog");

    const refused = await server.fetchRaw(`/api/pages/${page.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: server.cookie() },
      body: JSON.stringify({ github: "not a thing !!!" }),
    });
    expect(refused.status).toBe(400);

    await link(server, page.id, "#12");
    await server.request(`/api/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ github: null }) });
    const current = (await board(server)).pages.find((candidate) => candidate.id === page.id)!;
    expect(current.github).toBeNull();
    expect(current.githubStatus).toBeNull();
  });

  it("keeps the link in the page's own file, so it travels with the Markdown", async () => {
    const github = fakeGithub({});
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    const first = await board(server);
    await configureRepo(server, first.project.id);
    const page = await makePage(server, "Filed work", "backlog");
    await link(server, page.id, "feat/rituals");

    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const directory = join(server.pagesDirectory, "wizard-simulator", "pages");
    const files = readdirSync(directory).filter((name) => name.endsWith(".md"));
    const contents = files.map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
    expect(contents).toContain('github: {"kind":"branch","name":"feat/rituals"}');
  });
});

describe("checking the connection", () => {
  it("confirms a reachable repository and says whether it is private", async () => {
    const github = fakeGithub({ "repo:wizards/simulator": { private: true } });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    await configureRepo(server, (await board(server)).project.id, "t");

    const { body } = await server.request<{ ok: boolean; repo: string; private: boolean }>(
      "/api/github/verify", { method: "POST", body: "{}" },
    );
    expect(body).toEqual({ ok: true, repo: "wizards/simulator", private: true });
  });

  it("explains a 404 as a token problem when a token is held, since GitHub hides private repos that way", async () => {
    const github = fakeGithub({});
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    await configureRepo(server, (await board(server)).project.id, "t");

    const { body } = await server.request<{ ok: boolean; message: string }>(
      "/api/github/verify", { method: "POST", body: "{}" },
    );
    expect(body.ok).toBe(false);
    expect(body.message).toContain("token");
  });

  it("asks for a repository before anything else", async () => {
    const github = fakeGithub({});
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);

    const { body } = await server.request<{ ok: boolean; reason: string }>(
      "/api/github/verify", { method: "POST", body: "{}" },
    );
    expect(body).toMatchObject({ ok: false, reason: "no_repo" });
  });
});

describe("the pull request picker", () => {
  it("offers the repository's open and draft pull requests, newest first", async () => {
    const github = fakeGithub({
      "open:wizards/simulator": [
        { number: 21, title: "Rework the circle", html_url: "u21", draft: false, head: { ref: "feat/circle" }, user: { login: "maren" } },
        { number: 20, title: "Half-finished idea", html_url: "u20", draft: true, head: { ref: "feat/idea" }, user: { login: "mira" } },
      ],
    });
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);
    await configureRepo(server, (await board(server)).project.id, "t");

    const { body } = await server.request<{ pulls: Array<Record<string, unknown>> }>("/api/github/pulls");
    expect(body.pulls).toEqual([
      { number: 21, title: "Rework the circle", url: "u21", state: "open", branch: "feat/circle", author: "maren" },
      { number: 20, title: "Half-finished idea", url: "u20", state: "draft", branch: "feat/idea", author: "mira" },
    ]);
  });

  it("offers nothing rather than failing when no repository is configured", async () => {
    const github = fakeGithub({});
    const server = await startTestServer(undefined, { githubFetcher: github.fetcher });
    await bootstrap(server);

    const { response, body } = await server.request<{ pulls: unknown[] }>("/api/github/pulls");
    expect(response.status).toBe(200);
    expect(body.pulls).toEqual([]);
  });
});
