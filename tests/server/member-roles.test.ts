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
    // The project role is the one that moved. The account beside it is untouched, because
    // owning this project is not a fact about her account.
    const listed = promoted.body.members.find((member) => member.id === maren.id)!;
    expect(listed.projectRole).toBe("owner");
    expect(listed.role).toBe("member");

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
    expect((await members(server))[0].projectRole).toBe("owner");
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

  /*
   * The role says what somebody may do; membership says where. Promoting Maren used to hand
   * her the whole installation, because every project query took "owner" as a reason to skip
   * the membership join - so a second owner saw, read, renamed and could archive projects
   * nobody had ever put her on.
   */
  describe("an owner still only reaches the projects they are on", () => {
    /** Promotes Maren, makes a project she is not on, and leaves her signed in. */
    async function promotedMemberAndAProjectSheIsNotOn(server: TestServer) {
      await bootstrap(server);
      await registerMember(server);
      await login(server, ownerAccount);
      const maren = (await members(server)).find((member) => member.email === MEMBER.email)!;
      await setRole(server, maren.id, "owner");
      const hidden = await server.request<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Secret Roadmap" }),
      });
      await login(server, MEMBER);
      return hidden.body.project.id;
    }

    it("leaves it out of the project list she picks from", async () => {
      const server = await startTestServer();
      await promotedMemberAndAProjectSheIsNotOn(server);

      const listed = await server.request<{ projects: { name: string }[] }>("/api/projects");
      expect(listed.body.projects.map((project) => project.name)).toEqual(["Wizard Simulator"]);
      // The board carries the same list, and it is the one the picker actually renders.
      const workspace = await server.request<{ projects: { name: string }[] }>("/api/board");
      expect(workspace.body.projects.map((project) => project.name)).toEqual(["Wizard Simulator"]);
    });

    it("refuses to read, rename or archive it, as though it were not there", async () => {
      const server = await startTestServer();
      const hidden = await promotedMemberAndAProjectSheIsNotOn(server);

      // 404 rather than 403: a project she is not on is not hers to be told about.
      const read = await server.request("/api/board", { headers: { "x-grimoire-project": hidden } });
      expect(read.response.status).toBe(404);
      const renamed = await server.request(`/api/projects/${hidden}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Pwned" }),
      });
      expect(renamed.response.status).toBe(404);
      const archived = await server.request(`/api/projects/${hidden}`, { method: "DELETE" });
      expect(archived.response.status).toBe(404);
    });

    it("keeps her owner powers on the project she is on", async () => {
      const server = await startTestServer();
      await promotedMemberAndAProjectSheIsNotOn(server);

      // The narrowing is about reach, not power: nothing she could already do is taken away.
      const created = await server.request("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: "Payments", color: "#8bb9c9" }),
      });
      expect(created.response.status).toBe(201);
      expect((await server.request<{ project: { name: string } }>("/api/board")).body.project.name)
        .toBe("Wizard Simulator");
    });

    it("leaves someone else's archived project off her restore list, and refuses the restore", async () => {
      const server = await startTestServer();
      const hidden = await promotedMemberAndAProjectSheIsNotOn(server);
      await login(server, ownerAccount);
      await server.request(`/api/projects/${hidden}`, { method: "DELETE" });
      await login(server, MEMBER);

      const archived = await server.request<{ projects: { id: string }[] }>("/api/projects/archived");
      expect(archived.body.projects.map((project) => project.id)).not.toContain(hidden);
      const restored = await server.request(`/api/projects/${hidden}/restore`, { method: "POST" });
      expect(restored.response.status).toBe(404);
    });

    it("still lets the owner who made it see and restore it", async () => {
      const server = await startTestServer();
      const hidden = await promotedMemberAndAProjectSheIsNotOn(server);
      await login(server, ownerAccount);
      await server.request(`/api/projects/${hidden}`, { method: "DELETE" });

      const archived = await server.request<{ projects: { id: string }[] }>("/api/projects/archived");
      expect(archived.body.projects.map((project) => project.id)).toContain(hidden);
      const restored = await server.request(`/api/projects/${hidden}/restore`, { method: "POST" });
      expect(restored.response.status).toBe(200);
    });
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
