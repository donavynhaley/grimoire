import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Member, ProjectSummary } from "../../shared/types";
import { hashPassword } from "../../server/security";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function login(server: TestServer, account: { email: string; password: string }) {
  return server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
}

async function registerMember(server: TestServer) {
  const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({}) });
  await server.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...MEMBER, inviteCode: invite.body.code }),
  });
}

async function members(server: TestServer, projectId?: string): Promise<Member[]> {
  const headers = projectId ? { "x-grimoire-project": projectId } : undefined;
  return (await server.request<{ members: Member[] }>("/api/board", { headers })).body.members;
}

async function setRole(server: TestServer, memberId: string, role: string, projectId?: string) {
  return server.request(`/api/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
    headers: projectId ? { "x-grimoire-project": projectId } : undefined,
  });
}

async function createProject(server: TestServer, name: string) {
  return server.request<{ project: { id: string } }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/*
 * The account role and the project role used to be the same fact stored twice, so the only
 * way to be an owner anywhere was to be one everywhere. These cover the split: an admin the
 * installation always has, and ownership that belongs to a project rather than an account.
 */
describe("the admin, and ownership that belongs to a project", () => {
  it("makes the account that sets the installation up its admin, and nothing else", async () => {
    const server = await startTestServer();
    const created = await bootstrap(server);
    expect(created.body.user.role).toBe("admin");

    // Registering through an invitation never yields another one.
    await registerMember(server);
    const maren = (await server.request<{ user: { role: string } }>("/api/session")).body.user;
    expect(maren.role).toBe("member");
  });

  it("gives a project to whoever created it, whatever their account says", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);

    // Maren is a plain member of the installation and still owns what she makes.
    const hers = await createProject(server, "Marla's Notebook");
    expect(hers.response.status).toBe(201);
    const board = await server.request<{ viewerIsOwner: boolean; currentUser: { role: string } }>("/api/board", {
      headers: { "x-grimoire-project": hers.body.project.id },
    });
    expect(board.body.currentUser.role).toBe("member");
    expect(board.body.viewerIsOwner).toBe(true);

    const named = await server.request(`/api/projects/${hers.body.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Marla's Grimoire" }),
    });
    expect(named.response.status).toBe(200);
  });

  it("promotes somebody on one project without granting them another", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await login(server, ownerAccount);
    const wizard = (await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects[0];
    const second = await createProject(server, "Familiar Tycoon");
    const maren = (await members(server, wizard.id)).find((member) => member.email === MEMBER.email)!;
    expect((await setRole(server, maren.id, "owner", wizard.id)).response.status).toBe(200);

    await login(server, MEMBER);
    // Owner of the one she was promoted on...
    const shaped = await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Payments", color: "#8bb9c9" }),
      headers: { "x-grimoire-project": wizard.id },
    });
    expect(shaped.response.status).toBe(201);
    // ...and not so much as a reader of the one she was not.
    const other = await server.request("/api/board", { headers: { "x-grimoire-project": second.body.project.id } });
    expect(other.response.status).toBe(404);
  });

  it("does not let a demotion in one project reach a project somebody owns elsewhere", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    const hers = await createProject(server, "Marla's Notebook");

    // Demoted where the admin is the owner - which is not where she is one.
    await login(server, ownerAccount);
    const wizard = (await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects[0];
    const maren = (await members(server, wizard.id)).find((member) => member.email === MEMBER.email)!;
    expect((await setRole(server, maren.id, "member", wizard.id)).response.status).toBe(200);

    await login(server, MEMBER);
    const still = await server.request<{ viewerIsOwner: boolean }>("/api/board", {
      headers: { "x-grimoire-project": hers.body.project.id },
    });
    expect(still.body.viewerIsOwner).toBe(true);
  });

  it("refuses to demote or remove the admin, from any project", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    await login(server, ownerAccount);
    const wizard = (await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects[0];
    const maren = (await members(server, wizard.id)).find((member) => member.email === MEMBER.email)!;
    await setRole(server, maren.id, "owner", wizard.id);
    const admin = (await members(server, wizard.id)).find((member) => member.email === ownerAccount.email)!;

    // Maren owns this project now, so she is refused for what the admin is, not for lacking power.
    await login(server, MEMBER);
    expect((await setRole(server, admin.id, "member", wizard.id)).response.status).toBe(409);
    const removed = await server.request(`/api/members/${admin.id}`, {
      method: "DELETE",
      headers: { "x-grimoire-project": wizard.id },
    });
    expect(removed.response.status).toBe(409);

    await login(server, ownerAccount);
    expect((await members(server, wizard.id)).find((member) => member.id === admin.id)!.role).toBe("admin");
  });

  it("lets the admin reach a project nobody put them on", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await registerMember(server);
    const hers = await createProject(server, "Marla's Notebook");

    await login(server, ownerAccount);
    const seen = await server.request<{ viewerIsOwner: boolean }>("/api/board", {
      headers: { "x-grimoire-project": hers.body.project.id },
    });
    expect(seen.response.status).toBe(200);
    // Reaching it is not enough; the admin can put it right, which is the point of the role.
    expect(seen.body.viewerIsOwner).toBe(true);
    expect((await server.request<{ projects: ProjectSummary[] }>("/api/projects")).body.projects
      .map((project) => project.name)).toContain("Marla's Notebook");
  });
});

/**
 * Builds a database in the shape the live installation is in now: an account role that is
 * also the project role, and the spillage from writing it across every membership row.
 */
async function legacyDatabase(): Promise<{ directory: string; first: string; second: string; alpha: string; beta: string }> {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-legacy-"));
  const database = new DatabaseSync(join(directory, "grimoire.sqlite"));
  database.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_members (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );`);

  const first = randomUUID();
  const second = randomUUID();
  const alpha = randomUUID();
  const beta = randomUUID();
  const hash = await hashPassword(ownerAccount.password);
  const addUser = (id: string, name: string, email: string, role: string, at: string) =>
    database
      .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, email, hash, role, at);
  // Both are account-wide owners, which is the only way a second owner could exist before.
  addUser(first, "Donavyn", ownerAccount.email, "owner", "2026-01-01T00:00:00.000Z");
  addUser(second, "Maren", MEMBER.email, "owner", "2026-02-01T00:00:00.000Z");

  const addProject = (id: string, name: string, slug: string, at: string) =>
    database
      .prepare("INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, slug, at, at);
  addProject(alpha, "Wizard Simulator", "wizard-simulator", "2026-01-01T00:00:00.000Z");
  addProject(beta, "Familiar Tycoon", "familiar-tycoon", "2026-02-01T00:00:00.000Z");

  const addMember = (project: string, user: string, role: string, at: string) =>
    database
      .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(project, user, role, at);
  // Donavyn made Wizard Simulator; Maren made Familiar Tycoon. The extra `owner` rows are the
  // spillage: promoting Maren wrote `owner` onto every membership row she held.
  addMember(alpha, first, "owner", "2026-01-01T00:00:00.000Z");
  addMember(alpha, second, "owner", "2026-03-01T00:00:00.000Z");
  addMember(beta, second, "owner", "2026-02-01T00:00:00.000Z");
  addMember(beta, first, "owner", "2026-04-01T00:00:00.000Z");
  database.close();
  return { directory, first, second, alpha, beta };
}

function rolesIn(directory: string) {
  const database = new DatabaseSync(join(directory, "grimoire.sqlite"));
  const accounts = database.prepare("SELECT id, role FROM users").all() as Array<{ id: string; role: string }>;
  const memberships = database
    .prepare("SELECT project_id, user_id, role FROM project_members")
    .all() as Array<{ project_id: string; user_id: string; role: string }>;
  database.close();
  return { accounts, memberships };
}

describe("reconciling an installation that predates the split", () => {
  it("keeps one admin, and hands each project to whoever made it", async () => {
    const { directory, first, second, alpha, beta } = await legacyDatabase();
    const server = await startTestServer(directory);
    await server.close();

    const { accounts, memberships } = rolesIn(directory);
    // The account that set the installation up, and no other.
    expect(accounts.find((account) => account.id === first)!.role).toBe("admin");
    expect(accounts.find((account) => account.id === second)!.role).toBe("member");
    expect(accounts.filter((account) => account.role === "admin")).toHaveLength(1);

    const roleOf = (project: string, user: string) =>
      memberships.find((row) => row.project_id === project && row.user_id === user)!.role;
    // Each creator keeps the project they made...
    expect(roleOf(alpha, first)).toBe("owner");
    expect(roleOf(beta, second)).toBe("owner");
    // ...and the rows the old promotion spilled onto other people's projects are reduced.
    expect(roleOf(alpha, second)).toBe("member");
    expect(roleOf(beta, first)).toBe("member");
  });

  it("leaves the reconciled roles alone on every later start", async () => {
    const { directory, alpha, second } = await legacyDatabase();
    await (await startTestServer(directory)).close();

    // A deliberate promotion after the migration must survive the next boot, which it would
    // not if the reconciliation ran again and re-derived every role from who created what.
    const database = new DatabaseSync(join(directory, "grimoire.sqlite"));
    database
      .prepare("UPDATE project_members SET role = 'owner' WHERE project_id = ? AND user_id = ?")
      .run(alpha, second);
    database.close();

    await (await startTestServer(directory)).close();
    expect(rolesIn(directory).memberships
      .find((row) => row.project_id === alpha && row.user_id === second)!.role).toBe("owner");
  });

  it("lets the reconciled admin sign in and reach both projects", async () => {
    const { directory } = await legacyDatabase();
    const server = await startTestServer(directory);

    expect((await login(server, ownerAccount)).response.status).toBe(200);
    const listed = await server.request<{ projects: ProjectSummary[] }>("/api/projects");
    expect(listed.body.projects.map((project) => project.name).sort())
      .toEqual(["Familiar Tycoon", "Wizard Simulator"]);
    await server.close();
  });

  /*
   * The one place the admin is a plain member of somebody else's project: they joined it
   * after it was made, so the reconciliation hands it to whoever did. That is the only way
   * the owner of a project ever gets to point the remove action at the admin.
   */
  it("will not let the owner of a project remove the admin from it", async () => {
    const { directory, beta, first } = await legacyDatabase();
    const server = await startTestServer(directory);
    await login(server, { email: MEMBER.email, password: ownerAccount.password });

    const board = await server.request<{ viewerIsOwner: boolean; members: Member[] }>("/api/board", {
      headers: { "x-grimoire-project": beta },
    });
    expect(board.body.viewerIsOwner).toBe(true);
    const admin = board.body.members.find((member) => member.id === first)!;
    expect(admin.projectRole).toBe("member");

    const removed = await server.request(`/api/members/${first}`, {
      method: "DELETE",
      headers: { "x-grimoire-project": beta },
    });
    expect(removed.response.status).toBe(409);
    expect(removed.body).toMatchObject({ error: "The admin cannot be removed" });
    await server.close();
  });

  it("leaves the other account owning only what it made", async () => {
    const { directory, alpha } = await legacyDatabase();
    const server = await startTestServer(directory);

    expect((await login(server, { email: MEMBER.email, password: ownerAccount.password })).response.status).toBe(200);
    // She is still on Wizard Simulator and can still work there; she just no longer runs it.
    const board = await server.request<{ viewerIsOwner: boolean }>("/api/board", {
      headers: { "x-grimoire-project": alpha },
    });
    expect(board.response.status).toBe(200);
    expect(board.body.viewerIsOwner).toBe(false);

    const refused = await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Payments", color: "#8bb9c9" }),
      headers: { "x-grimoire-project": alpha },
    });
    expect(refused.response.status).toBe(403);
    await server.close();
  });
});
