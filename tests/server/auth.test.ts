import { describe, expect, it } from "vitest";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

describe("authentication", () => {
  it("starts in setup mode and bootstraps exactly one owner", async () => {
    const server = await startTestServer();

    const initial = await server.request<{ status: string }>("/api/session");
    expect(initial.response.status).toBe(200);
    expect(initial.body.status).toBe("setup_required");

    const created = await bootstrap(server);
    expect(created.response.status).toBe(201);
    expect(created.body.user).toMatchObject({ name: "Donavyn", role: "admin" });

    const duplicate = await server.request("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ ...ownerAccount, email: "other@example.com" }),
    });
    expect(duplicate.response.status).toBe(409);
  });

  it("admits exactly one admin when two setup requests race", async () => {
    const server = await startTestServer();

    // Both requests pass the early emptiness check before either inserts - the
    // password hashing between them yields the event loop. The INSERT itself is
    // what must refuse the second one.
    const [first, second] = await Promise.all([
      fetch(`${server.baseUrl}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ownerAccount),
      }),
      fetch(`${server.baseUrl}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ownerAccount, email: "rival@example.com" }),
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
  });

  it("supports logout and password login without exposing password data", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const logout = await server.request("/api/auth/logout", { method: "POST" });
    expect(logout.response.status).toBe(200);

    const denied = await server.request("/api/board");
    expect(denied.response.status).toBe(401);

    const login = await server.request<{ user: Record<string, unknown> }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(login.response.status).toBe(200);
    expect(login.body.user).not.toHaveProperty("passwordHash");
    expect(login.body.user).not.toHaveProperty("password_hash");
  });

  it("changes an authenticated password only after verifying the current password", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const newPassword = "an even newer secure wizard password";

    const denied = await server.request("/api/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "wrong password", newPassword }),
    });
    expect(denied.response.status).toBe(401);

    const changed = await server.request("/api/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: ownerAccount.password, newPassword }),
    });
    expect(changed.response.status).toBe(200);

    await server.request("/api/auth/logout", { method: "POST" });
    const oldLogin = await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(oldLogin.response.status).toBe(401);

    const newLogin = await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: newPassword }),
    });
    expect(newLogin.response.status).toBe(200);
  });

  it("allows an owner to issue exactly one active single-use invitation", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const supersededInvite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(invite.response.status).toBe(201);
    expect(invite.body.code.length).toBeGreaterThanOrEqual(20);

    await server.request("/api/auth/logout", { method: "POST" });
    const superseded = await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: supersededInvite.body.code,
        name: "Kamryn",
        email: "kamryn@example.com",
        password: "one more secure wizard password",
      }),
    });
    expect(superseded.response.status).toBe(409);

    const registration = await server.request<{ user: { role: string } }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: invite.body.code,
        name: "Frankie",
        email: "frankie@example.com",
        password: "another secure wizard password",
      }),
    });
    expect(registration.response.status).toBe(201);
    expect(registration.body.user.role).toBe("member");

    const reused = await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: invite.body.code,
        name: "Kamryn",
        email: "kamryn@example.com",
        password: "one more secure wizard password",
      }),
    });
    expect(reused.response.status).toBe(409);
  });

  it("lets only the owner remove a member and immediately revokes their access", async () => {
    const server = await startTestServer();
    const owner = await bootstrap(server);
    const invite = await server.request<{ code: string }>("/api/invites", { method: "POST" });
    await server.request("/api/auth/logout", { method: "POST" });

    const registration = await server.request<{ user: { id: string } }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: invite.body.code,
        name: "Frankie",
        email: "frankie@example.com",
        password: "another secure wizard password",
      }),
    });
    const memberId = registration.body.user.id;
    const memberBoard = await server.request<{ members: Array<{ id: string; projectRole: string }> }>(
      "/api/board",
    );
    // Owning the project is a project role now; the account beside it says only "admin".
    const ownerId = memberBoard.body.members.find((member) => member.projectRole === "owner")!.id;

    const forbidden = await server.request(`/api/members/${ownerId}`, { method: "DELETE" });
    expect(forbidden.response.status).toBe(403);

    const page = await server.request<{ page: { id: string } }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Write Frankie's spell notes", assigneeId: memberId }),
    });
    expect(page.response.status).toBe(201);

    const memberEvents = await server.events("removed-member");
    const eventReader = memberEvents.body!.getReader();
    expect(new TextDecoder().decode((await eventReader.read()).value)).toContain("connected");

    const ownerLogin = await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(ownerLogin.response.status).toBe(200);

    const cannotRemoveOwner = await server.request(`/api/members/${ownerId}`, { method: "DELETE" });
    expect(cannotRemoveOwner.response.status).toBe(409);

    const removed = await server.request(`/api/members/${memberId}`, { method: "DELETE" });
    expect(removed.response.status).toBe(200);
    expect((await eventReader.read()).done).toBe(true);

    const ownerBoard = await server.request<{
      pages: Array<{ id: string; assigneeId: string | null; createdByName: string }>;
      members: Array<{ id: string }>;
    }>("/api/board");
    expect(ownerBoard.body.members.some((member) => member.id === memberId)).toBe(false);
    expect(ownerBoard.body.pages.find((candidate) => candidate.id === page.body.page.id)).toMatchObject({
      assigneeId: null,
      createdByName: "Frankie",
    });

    await server.request("/api/auth/logout", { method: "POST" });
    const removedLogin = await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "frankie@example.com", password: "another secure wizard password" }),
    });
    expect(removedLogin.response.status).toBe(401);
    expect(owner.body.user.role).toBe("admin");
  });
});
