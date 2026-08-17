import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentToken, AuditPage, Member } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function login(server: TestServer, account: { email: string; password: string }) {
  await server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.email, password: account.password }),
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

async function members(server: TestServer): Promise<Member[]> {
  const { body } = await server.request<{ members: Member[] }>("/api/board");
  return body.members;
}

async function setRole(server: TestServer, memberId: string, role: string) {
  return server.request<{ members: Member[] }>(`/api/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

describe("member roles", () => {
  it("promotes a member, and the promotion is what actually grants owner powers", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);

    // As a member, Maren cannot reshape the project.
    const refused = await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Payments", color: "#8bb9c9" }),
    });
    expect(refused.response.status).toBe(403);

    await login(server, ownerAccount);
    const maren = (await members(server)).find((member) => member.email === MEMBER.email)!;
    const promoted = await setRole(server, maren.id, "owner");
    expect(promoted.response.status).toBe(200);
    // Both roles move together, so the board never shows a member who can restructure it.
    const listed = promoted.body.members.find((member) => member.id === maren.id)!;
    expect(listed.role).toBe("owner");
    expect(listed.projectRole).toBe("owner");

    await login(server, MEMBER);
    const allowed = await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Payments", color: "#8bb9c9" }),
    });
    expect(allowed.response.status).toBe(201);
  });

  it("demotes an owner back to a member, and the powers go with the role", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await login(server, ownerAccount);
    const maren = (await members(server)).find((member) => member.email === MEMBER.email)!;
    await setRole(server, maren.id, "owner");

    await login(server, MEMBER);
    expect((await server.request("/api/agent-tokens")).response.status).toBe(200);

    await login(server, ownerAccount);
    await setRole(server, maren.id, "member");

    await login(server, MEMBER);
    expect((await server.request("/api/agent-tokens")).response.status).toBe(403);
  });

  it("refuses a member who tries to promote anyone, including themselves", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await login(server, ownerAccount);
    const ownerId = (await members(server))[0].id;
    await registerMember(server);
    const maren = (await server.request<{ user: { id: string } }>("/api/session")).body.user;

    expect((await setRole(server, maren.id, "owner")).response.status).toBe(403);
    expect((await setRole(server, ownerId, "member")).response.status).toBe(403);

    await login(server, ownerAccount);
    expect((await members(server)).find((member) => member.email === MEMBER.email)!.role).toBe("member");
  });

  it("refuses an owner changing their own role, so a sole owner cannot lock the instance", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const owner = (await members(server))[0];

    const attempt = await setRole(server, owner.id, "member");
    expect(attempt.response.status).toBe(409);
    expect((await members(server))[0].role).toBe("owner");
  });

  it("answers 404 for someone who is not a member of this project", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    expect((await setRole(server, randomUUID(), "owner")).response.status).toBe(404);
  });

  it("records the change in the activity log, naming both roles", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await login(server, ownerAccount);
    const maren = (await members(server)).find((member) => member.email === MEMBER.email)!;
    await setRole(server, maren.id, "owner");

    const { body } = await server.request<AuditPage>("/api/activity");
    const event = body.events.find((candidate) => candidate.entityType === "member");
    expect(event?.action).toBe("updated");
    expect(event?.entityTitle).toBe("Maren");
    expect(event?.changes).toEqual([{ field: "role", from: "member", to: "owner" }]);
  });

  it("is closed to an agent token, whatever its scope", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const issued = await server.request<{ token: AgentToken; secret: string }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Planning agent", scope: "write" }),
    });
    const owner = (await members(server))[0];

    const attempt = await fetch(`${server.baseUrl}/api/members/${owner.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${issued.body.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(attempt.status).toBe(403);
  });
});
