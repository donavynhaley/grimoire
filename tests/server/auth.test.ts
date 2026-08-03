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
    expect(created.body.user).toMatchObject({ name: "Donavyn", role: "owner" });

    const duplicate = await server.request("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ ...ownerAccount, email: "other@example.com" }),
    });
    expect(duplicate.response.status).toBe(409);
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

  it("allows an owner to invite a collaborator", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(invite.response.status).toBe(201);
    expect(invite.body.code.length).toBeGreaterThanOrEqual(20);

    await server.request("/api/auth/logout", { method: "POST" });
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
});
