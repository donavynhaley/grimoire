import { describe, expect, it } from "vitest";
import type { AgentReview, AgentToken, DiscussionThread, Page } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function review(server: TestServer): Promise<AgentReview> {
  return (await server.request<AgentReview>("/api/agent-review")).body;
}

async function markReviewed(server: TestServer, sequence?: number) {
  return server.request("/api/agent-review/seen", {
    method: "POST",
    body: JSON.stringify(sequence === undefined ? {} : { sequence }),
  });
}

async function loginOwner(server: TestServer) {
  await server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
  });
}

async function loginMember(server: TestServer) {
  await server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER.email, password: MEMBER.password }),
  });
}

/** Invites and registers Maren, leaving the session signed in as her. */
async function registerMember(server: TestServer) {
  const invite = await server.request<{ code: string }>("/api/invites", {
    method: "POST",
    body: JSON.stringify({}),
  });
  await server.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...MEMBER, inviteCode: invite.body.code }),
  });
}

async function issue(server: TestServer): Promise<{ token: AgentToken; secret: string }> {
  return (
    await server.request<{ token: AgentToken; secret: string }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Planning agent", scope: "write" }),
    })
  ).body;
}

/** A request as an agent would really make it: a bearer header and no browser session. */
async function asAgent(
  server: TestServer,
  secret: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: { error?: string } | null }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${server.baseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function agentCreatesPage(server: TestServer, secret: string, title: string): Promise<Page> {
  const { body } = await asAgent(server, secret, "/api/pages", {
    method: "POST",
    body: JSON.stringify({ title, status: "ready" }),
  });
  return (body as unknown as { page: Page }).page;
}

describe("the agent review", () => {
  it("shows a first look everything agents ever did, not only the recent part", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Drafted overnight");

    const state = await review(server);
    expect(state.since).toBe(0);
    expect(state.total).toBe(1);
    expect(state.events.map((event) => [event.action, event.entityTitle])).toEqual([
      ["created", "Drafted overnight"],
    ]);
  });

  it("names the agent and its credential on every event and lists nothing people did themselves", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Agent work");
    await server.request("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Human work", status: "ready" }),
    });

    const state = await review(server);
    expect(state.total).toBe(1);
    expect(state.events[0]?.entityTitle).toBe("Agent work");
    expect(state.events[0]?.agentName).toBe("Planning agent");
    expect(state.events[0]?.agentTokenId).toBe(issued.token.id);
    expect(state.events[0]?.actorName).toBe(ownerAccount.name);
  });

  it("counts your own agent's work as news to you, unlike the away digest", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    // The credential acts as the owner, and the owner is also the one reviewing.
    await agentCreatesPage(server, issued.secret, "Written as its issuer");

    const state = await review(server);
    expect(state.total).toBe(1);
    expect(state.events[0]?.agentName).toBe("Planning agent");
  });

  it("advances only through its own cursor, privately per person", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await loginOwner(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Reviewed by one, not the other");

    // The away cursor moving must not consume the review.
    await server.request("/api/seen", { method: "POST", body: JSON.stringify({}) });
    expect((await review(server)).total).toBe(1);

    await markReviewed(server);
    const after = await review(server);
    expect(after.total).toBe(0);
    expect(after.since).toBe(after.latest);

    await loginMember(server);
    expect((await review(server)).total).toBe(1);
  });

  it("clamps the cursor to what exists and never rewinds it", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "The only change");

    await markReviewed(server, 999999);
    const clamped = await review(server);
    expect(clamped.since).toBe(clamped.latest);

    await markReviewed(server, 0);
    expect((await review(server)).since).toBe(clamped.latest);
  });

  it("reviews up to a passed sequence so a capped look marks only what it showed", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Seen");
    const firstLook = await review(server);
    await agentCreatesPage(server, issued.secret, "Not yet seen");

    await markReviewed(server, firstLook.latest);
    const second = await review(server);
    expect(second.total).toBe(1);
    expect(second.events[0]?.entityTitle).toBe("Not yet seen");
  });

  it("holds an agent's open question as waiting until a person answers it", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    const page = await agentCreatesPage(server, issued.secret, "Needs a decision");
    await asAgent(server, issued.secret, `/api/pages/${page.id}/discussion`, {
      method: "POST",
      body: JSON.stringify({ body: "Which of the two doors should this ward?" }),
    });
    // A person's own thread is not an agent waiting on anyone.
    await server.request(`/api/pages/${page.id}/discussion`, {
      method: "POST",
      body: JSON.stringify({ body: "A human question." }),
    });

    // Reviewing does not answer anything: the question outlives the cursor.
    await markReviewed(server);
    const state = await review(server);
    expect(state.waiting.map((thread) => [thread.pageTitle, thread.agentName])).toEqual([
      ["Needs a decision", "Planning agent"],
    ]);
    expect(state.waiting[0]?.agentTokenId).toBe(issued.token.id);
    expect(state.waiting[0]?.body).toBe("Which of the two doors should this ward?");

    const threads = (
      await server.request<{ threads: DiscussionThread[] }>(`/api/pages/${page.id}/discussion`)
    ).body.threads;
    const asked = threads.find((thread) => thread.agentName !== null);
    await server.request(`/api/pages/${page.id}/discussion/${asked?.id}/answered`, {
      method: "POST",
      body: JSON.stringify({ answered: true }),
    });
    expect((await review(server)).waiting).toEqual([]);
  });

  it("sends the credential rail to the owner and to nobody else", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await loginOwner(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Visible to both, revocable by one");

    const owners = await review(server);
    expect(owners.credentials?.map((token) => token.id)).toEqual([issued.token.id]);

    await loginMember(server);
    const members = await review(server);
    expect(members.total).toBe(1);
    expect(members.credentials).toBeUndefined();
  });

  it("keeps naming a revoked credential on the work it already did", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);
    await agentCreatesPage(server, issued.secret, "Written before the revoke");
    await server.request(`/api/agent-tokens/${issued.token.id}`, { method: "DELETE" });

    const state = await review(server);
    expect(state.events.some((event) => event.agentName === "Planning agent")).toBe(true);
  });

  it("is closed to agents, because no agent approves its own work", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await issue(server);

    const read = await asAgent(server, issued.secret, "/api/agent-review");
    expect(read.response.status).toBe(403);
    const advance = await asAgent(server, issued.secret, "/api/agent-review/seen", {
      method: "POST",
      body: "{}",
    });
    expect(advance.response.status).toBe(403);
  });
});
