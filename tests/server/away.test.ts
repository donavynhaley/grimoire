import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AwayState, BoardWorkspace, Page } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function away(server: TestServer): Promise<AwayState> {
  return (await server.request<AwayState>("/api/away")).body;
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
  const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({}) });
  await server.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...MEMBER, inviteCode: invite.body.code }),
  });
}

async function createPage(server: TestServer, title: string): Promise<Page> {
  return (await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title, status: "ready" }),
  })).body.page;
}

describe("while you were away", () => {
  it("starts a new reader at the present instead of dumping history", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await createPage(server, "Pre-existing work");

    const first = await away(server);
    expect(first.total).toBe(0);
    expect(first.events).toEqual([]);
    expect(first.since).toBe(first.latest);
    expect(first.latest).toBeGreaterThan(0);
  });

  it("reports what teammates did while away and never your own actions", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await away(server); // Maren's first look pins her cursor to the present.
    await createPage(server, "Maren's own page");

    await loginOwner(server);
    const page = await createPage(server, "Enchant the tower door");
    await server.request(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done", position: 0 }),
    });

    await loginMember(server);
    const state = await away(server);
    expect(state.total).toBe(2);
    expect(state.events.map((event) => [event.action, event.entityTitle])).toEqual([
      ["created", "Enchant the tower door"],
      ["moved", "Enchant the tower door"],
    ]);
    expect(state.events.every((event) => event.actorName === "Donavyn")).toBe(true);
    expect(state.events[0].sequence).toBeLessThan(state.events[1].sequence);
  });

  it("advances with MAX semantics and clamps to the newest real sequence", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await away(server);

    await loginOwner(server);
    await createPage(server, "First change");

    await loginMember(server);
    expect((await away(server)).total).toBe(1);
    await server.request("/api/seen", { method: "POST", body: JSON.stringify({}) });
    expect((await away(server)).total).toBe(0);

    // A wildly future sequence clamps to the present, so the next real change still counts.
    await server.request("/api/seen", { method: "POST", body: JSON.stringify({ sequence: 9_999_999 }) });
    await loginOwner(server);
    await createPage(server, "Second change");
    await loginMember(server);
    expect((await away(server)).total).toBe(1);

    // A stale advance can never rewind the boundary.
    await server.request("/api/seen", { method: "POST", body: JSON.stringify({ sequence: 1 }) });
    expect((await away(server)).total).toBe(1);
  });

  it("removes the cursor when the member is removed", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await away(server);
    const memberId = (await server.request<BoardWorkspace>("/api/board")).body.currentUser.id;

    await loginOwner(server);
    await server.request(`/api/members/${memberId}`, { method: "DELETE", body: JSON.stringify({}) });

    const database = new DatabaseSync(server.databasePath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT COUNT(*) AS count FROM seen_cursors WHERE user_id = ?").get(memberId) as {
        count: number;
      };
      expect(Number(rows.count)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("gates the project-wide history to the owner while page history stays shared", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Shared page");
    await registerMember(server);

    const denied = await server.request<{ error: string }>("/api/activity");
    expect(denied.response.status).toBe(403);
    const pageHistory = await server.request(`/api/activity?entity=${page.id}`);
    expect(pageHistory.response.status).toBe(200);

    await loginOwner(server);
    expect((await server.request("/api/activity")).response.status).toBe(200);
  });
});
