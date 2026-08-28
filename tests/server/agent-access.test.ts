import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToken, AuditPage, AwayState, BoardWorkspace, Page } from "../../shared/types";
import { AgentRateLimiter } from "../../server/agent-tokens";
import { requireUnchangedContent } from "../../server/repository";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A directory this file owns, for the tests that reopen a database after closing its server.
 * `startTestServer` deletes any directory it created itself, which would take the file too.
 */
function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-agent-"));
  directories.push(directory);
  return directory;
}

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

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

async function issue(server: TestServer, body: Record<string, unknown> = {}) {
  return server.request<{ token: AgentToken; secret: string }>("/api/agent-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "Planning agent", scope: "write", ...body }),
  });
}

/**
 * A request as an agent would really make it: a bearer header and no browser session.
 *
 * The shared helper always attaches the session cookie, which would hide the very thing
 * these tests are about.
 */
async function asAgent(
  server: TestServer,
  secret: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${server.baseUrl}${path}`, { ...init, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}

function agentPage(title: string) {
  return { method: "POST", body: JSON.stringify({ title, status: "ready" }) };
}

describe("agent access", () => {
  describe("the credential", () => {
    it("issues a secret exactly once and never reveals it again", async () => {
      const server = await startTestServer();
      await bootstrap(server);

      const created = await issue(server);
      expect(created.response.status).toBe(201);
      expect(created.body.secret).toMatch(/^grim_/);
      expect(created.body.token.ownerName).toBe("Donavyn");
      expect(created.body.token.scope).toBe("write");

      const listed = await server.request<{ tokens: AgentToken[] }>("/api/agent-tokens");
      expect(listed.body.tokens).toHaveLength(1);
      // The listing carries everything but the secret.
      expect(JSON.stringify(listed.body.tokens)).not.toContain(created.body.secret);
    });

    it("stores only the hash, so the database never holds the secret", async () => {
      // The directory is owned here so closing the server does not take the database with it.
      const server = await startTestServer(makeDirectory());
      await bootstrap(server);
      const created = await issue(server);
      await server.close();

      const database = new DatabaseSync(server.databasePath);
      const rows = database.prepare("SELECT token_hash FROM agent_tokens").all() as Array<{
        token_hash: string;
      }>;
      database.close();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toBe(created.body.secret);
      expect(rows[0]!.token_hash).not.toContain("grim_");
    });

    it("lets an agent write a page that a person can then see on the board", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      const written = await asAgent(server, body.secret, "/api/pages", agentPage("Ward the tower door"));
      expect(written.response.status).toBe(201);

      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages.map((page) => page.title)).toContain("Ward the tower door");
      // The write is attributed to the person who issued the token, not to a machine account.
      expect(board.body.pages[0]!.createdByName).toBe("Donavyn");
    });

    it("refuses a malformed, unknown, or unprefixed bearer token", async () => {
      const server = await startTestServer();
      await bootstrap(server);

      for (const secret of ["nonsense", "grim_not-a-real-token", ""]) {
        const attempt = await asAgent(server, secret, "/api/board");
        expect(attempt.response.status).toBe(401);
      }
    });

    it("refuses a revoked token but keeps what it already wrote", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      await asAgent(server, body.secret, "/api/pages", agentPage("Written before revoking"));

      const revoked = await server.request(`/api/agent-tokens/${body.token.id}`, { method: "DELETE" });
      expect(revoked.response.status).toBe(200);

      const afterwards = await asAgent(
        server,
        body.secret,
        "/api/pages",
        agentPage("Written after revoking"),
      );
      expect(afterwards.response.status).toBe(401);

      const board = await server.request<BoardWorkspace>("/api/board");
      const titles = board.body.pages.map((page) => page.title);
      expect(titles).toContain("Written before revoking");
      expect(titles).not.toContain("Written after revoking");
    });

    it("refuses an expired token", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { expiresAt: new Date(Date.now() - 1000).toISOString() });

      const attempt = await asAgent(server, body.secret, "/api/board");
      expect(attempt.response.status).toBe(401);
    });

    it("stops working when its issuer is removed from the project", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);

      const board = await server.request<BoardWorkspace>("/api/board");
      const maren = board.body.members.find((member) => member.email === MEMBER.email)!;

      // The owner issues on their own behalf, so borrow Maren's session to issue as her.
      await loginMember(server);
      const memberAttempt = await issue(server, { name: "Maren's agent" });
      // Only the owner may issue at all, which is itself the first line of defence.
      expect(memberAttempt.response.status).toBe(403);

      await loginOwner(server);
      const { body } = await issue(server);
      await server.request(`/api/members/${maren.id}`, { method: "DELETE" });

      // The owner's own token is unaffected by removing someone else.
      const stillWorks = await asAgent(server, body.secret, "/api/board");
      expect(stillWorks.response.status).toBe(200);
    });
  });

  describe("a session always beats a bearer header", () => {
    it("keeps a signed-in person a person even when a token is also sent", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      // Both credentials on one request. The cookie must win, or a person holding a token
      // would silently have their own work recorded as an agent's.
      const both = await server.request<{ page: Page }>("/api/pages", {
        method: "POST",
        headers: { authorization: `Bearer ${body.secret}` },
        body: JSON.stringify({ title: "Written by a person", status: "ready" }),
      });
      expect(both.response.status).toBe(201);

      const activity = await server.request<AuditPage>("/api/activity");
      const event = activity.body.events.find((candidate) => candidate.entityTitle === "Written by a person");
      expect(event?.agentName).toBeNull();
    });
  });

  describe("scopes", () => {
    it("refuses every write route to a read-only token but allows the reads", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { name: "Reader", scope: "read" });

      expect((await asAgent(server, body.secret, "/api/board")).response.status).toBe(200);
      expect((await asAgent(server, body.secret, "/api/search?q=a")).response.status).toBe(200);
      expect((await asAgent(server, body.secret, "/api/ideas")).response.status).toBe(200);

      const page = await asAgent(server, body.secret, "/api/pages", agentPage("Should never exist"));
      expect(page.response.status).toBe(403);
      const idea = await asAgent(server, body.secret, "/api/ideas", {
        method: "POST",
        body: JSON.stringify({ title: "Should never exist" }),
      });
      expect(idea.response.status).toBe(403);

      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages).toHaveLength(0);
    });
  });

  describe("reading one page", () => {
    it("serves a single page to a read-only token, in the shape the board uses", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { name: "Reader", scope: "read" });
      const created = (await server.request<{ page: Page }>("/api/pages", agentPage("A page worth reading")))
        .body.page;

      const read = await asAgent(server, body.secret, `/api/pages/${created.id}`);
      expect(read.response.status).toBe(200);
      // Identical to the board's own record, so an agent never has to reconcile two shapes.
      const board = await server.request<BoardWorkspace>("/api/board");
      expect(read.body.page).toEqual(board.body.pages.find((candidate) => candidate.id === created.id));

      // And it is the same route for a person at a browser, not an agent-only affordance.
      const person = await server.request<{ page: Page }>(`/api/pages/${created.id}`);
      expect(person.response.status).toBe(200);
      expect(person.body.page).toEqual(read.body.page);
    });

    it("answers 404 for an unknown page and for one that was archived", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { name: "Reader", scope: "read" });
      const created = (await server.request<{ page: Page }>("/api/pages", agentPage("Soon archived"))).body
        .page;

      const missing = await asAgent(server, body.secret, `/api/pages/${randomUUID()}`);
      expect(missing.response.status).toBe(404);

      // A person archives it; the archive is reachable through search, not through this route.
      await server.request(`/api/pages/${created.id}`, { method: "DELETE" });
      const archived = await asAgent(server, body.secret, `/api/pages/${created.id}`);
      expect(archived.response.status).toBe(404);
    });
  });

  describe("what no token may ever do", () => {
    it("refuses archiving, restoring, and promoting whatever the scope", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      const page = (await server.request<{ page: Page }>("/api/pages", agentPage("A real page"))).body.page;
      const idea = (
        await server.request<{ idea: { id: string } }>("/api/ideas", {
          method: "POST",
          body: JSON.stringify({ title: "A real idea" }),
        })
      ).body.idea;

      const forbidden = [
        [`/api/pages/${page.id}`, "DELETE"],
        [`/api/pages/${page.id}/restore`, "POST"],
        [`/api/ideas/${idea.id}/promote`, "POST"],
        [`/api/ideas/${idea.id}/promotion`, "DELETE"],
      ] as const;

      for (const [path, method] of forbidden) {
        const attempt = await asAgent(server, body.secret, path, { method, body: "{}" });
        expect(attempt.response.status, `${method} ${path}`).toBe(403);
      }

      // The page is still there, unarchived.
      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages.map((candidate) => candidate.id)).toContain(page.id);
    });

    it("refuses everything that reshapes the project or the account", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      const workspace = (await server.request<BoardWorkspace>("/api/board")).body;

      const forbidden = [
        ["/api/chapters", "POST"],
        ["/api/chapters/anything", "PATCH"],
        ["/api/chapters/anything", "DELETE"],
        ["/api/categories", "POST"],
        ["/api/categories/design", "PATCH"],
        ["/api/categories/design", "DELETE"],
        ["/api/invites", "POST"],
        ["/api/projects", "POST"],
        [`/api/projects/${workspace.project.id}`, "PATCH"],
        [`/api/projects/${workspace.project.id}`, "DELETE"],
        [`/api/members/${workspace.currentUser.id}`, "DELETE"],
        ["/api/account/password", "POST"],
        ["/api/account/name", "POST"],
        ["/api/account/avatar", "DELETE"],
        ["/api/seen", "POST"],
        ["/api/images", "POST"],
      ] as const;

      for (const [path, method] of forbidden) {
        const attempt = await asAgent(server, body.secret, path, { method, body: "{}" });
        expect(attempt.response.status, `${method} ${path}`).toBe(403);
      }
    });

    it("refuses a route nobody has written yet, because the list is closed by default", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      // The lists above prove today's routes are refused; this proves the *policy* - the
      // allow-list gate runs before routing, so a route added next month is closed to
      // agents until someone opens it deliberately. If this refusal ever becomes a 404,
      // routes have started answering agents before the policy sees them.
      for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
        const attempt = await asAgent(server, body.secret, "/api/some-route-from-the-future", {
          method,
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect(attempt.response.status, method).toBe(403);
        expect(attempt.body.error, method).toContain("agent token");
      }
    });

    it("refuses to mint or revoke another token", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      const minted = await asAgent(server, body.secret, "/api/agent-tokens", {
        method: "POST",
        body: JSON.stringify({ name: "A second agent", scope: "write" }),
      });
      expect(minted.response.status).toBe(403);
      expect((await asAgent(server, body.secret, "/api/agent-tokens")).response.status).toBe(403);
      const revoked = await asAgent(server, body.secret, `/api/agent-tokens/${body.token.id}`, {
        method: "DELETE",
      });
      expect(revoked.response.status).toBe(403);
    });

    it("cannot hold an event stream, so it never counts as present", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      const stream = await asAgent(server, body.secret, "/api/events?client=agent");
      expect(stream.response.status).toBe(403);
    });
  });

  describe("project pinning", () => {
    it("keeps a token inside its own project, named or not", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const first = (await server.request<BoardWorkspace>("/api/board")).body.project;
      const second = (
        await server.request<{ project: { id: string } }>("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Second project" }),
        })
      ).body.project;
      expect(second.id).not.toBe(first.id);

      // The token is issued while the owner is looking at the first project.
      const { body } = await issue(server, {}); // header-less issue targets the default project
      const issuedFor = first.id;

      // Naming the other project is refused rather than quietly redirected.
      const crossed = await asAgent(server, body.secret, "/api/board", {
        headers: { "x-grimoire-project": second.id },
      });
      expect(crossed.response.status).toBe(403);

      // Naming its own project is fine, and omitting the header lands there too.
      const named = await asAgent(server, body.secret, "/api/board", {
        headers: { "x-grimoire-project": issuedFor },
      });
      expect(named.response.status).toBe(200);
      expect(named.body.project.id).toBe(issuedFor);

      const bare = await asAgent(server, body.secret, "/api/board");
      expect(bare.body.project.id).toBe(issuedFor);

      // And a write with the other project named writes nothing anywhere.
      const write = await asAgent(server, body.secret, "/api/pages", {
        method: "POST",
        headers: { "x-grimoire-project": second.id },
        body: JSON.stringify({ title: "Leaked across projects", status: "ready" }),
      });
      expect(write.response.status).toBe(403);
      const secondBoard = await server.request<BoardWorkspace>(`/api/board?project=${second.id}`);
      expect(secondBoard.body.pages).toHaveLength(0);
    });
  });

  describe("attribution", () => {
    it("names the agent in the activity log while crediting the person", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      await asAgent(server, body.secret, "/api/pages", agentPage("Drafted by the agent"));

      const activity = await server.request<AuditPage>("/api/activity");
      const event = activity.body.events.find(
        (candidate) => candidate.entityTitle === "Drafted by the agent",
      );
      expect(event).toBeDefined();
      // The person stays accountable, and the agent is named beside them.
      expect(event!.actorName).toBe("Donavyn");
      expect(event!.agentName).toBe("Planning agent");
    });

    it("still names a revoked agent in the history it wrote", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      await asAgent(server, body.secret, "/api/pages", agentPage("Written then retired"));
      await server.request(`/api/agent-tokens/${body.token.id}`, { method: "DELETE" });

      const activity = await server.request<AuditPage>("/api/activity");
      const event = activity.body.events.find(
        (candidate) => candidate.entityTitle === "Written then retired",
      );
      // Revoking must not rewrite what already happened.
      expect(event!.agentName).toBe("Planning agent");
    });

    /**
     * A rebuild that named fewer columns than the table has would drop the rest in silence.
     * Adding any future entity type fires that rebuild, so this stands a database up in the
     * shape one would have then - a narrower CHECK, and attribution already recorded - and
     * checks the migration carries it across rather than quietly erasing who wrote what.
     */
    it("keeps attribution when the activity log is rebuilt for a new entity type", async () => {
      const directory = makeDirectory();
      const databasePath = join(directory, "grimoire.sqlite");
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
          pitch TEXT NOT NULL DEFAULT '', player_fantasy TEXT NOT NULL DEFAULT '',
          current_direction TEXT NOT NULL DEFAULT '', direction_detail TEXT NOT NULL DEFAULT '',
          non_goals TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE agent_tokens (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
          name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          actor_id TEXT REFERENCES users(id), actor_name TEXT NOT NULL,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('page', 'idea', 'project', 'category', 'member')),
          entity_id TEXT, entity_title TEXT NOT NULL, action TEXT NOT NULL,
          changes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
          agent_token_id TEXT REFERENCES agent_tokens(id));
        INSERT INTO projects (id, name, slug, created_at, updated_at)
          VALUES ('p1', 'Wizard Simulator', 'wizard-simulator', '2026-01-01', '2026-01-01');
        INSERT INTO users (id, name, email, password_hash, role, created_at)
          VALUES ('u1', 'Donavyn', 'owner@example.com', 'x', 'owner', '2026-01-01');
        INSERT INTO agent_tokens (id, project_id, user_id, name, token_hash, scope, created_at)
          VALUES ('t1', 'p1', 'u1', 'Planning agent', 'hash', 'write', '2026-01-01');
        INSERT INTO audit_events (sequence, id, project_id, actor_id, actor_name, entity_type,
          entity_id, entity_title, action, changes, created_at, agent_token_id)
          VALUES (7, 'e1', 'p1', 'u1', 'Donavyn', 'page', 'x1', 'Written before a rebuild',
            'created', '[]', '2026-01-01', 't1');
      `);
      database.close();

      // Opening the server runs the migration, which must widen the CHECK without loss.
      const reopened = await startTestServer(directory);
      const stored = new DatabaseSync(reopened.databasePath);
      const row = stored
        .prepare("SELECT sequence, entity_title, agent_token_id FROM audit_events WHERE id = 'e1'")
        .get() as { sequence: number; entity_title: string; agent_token_id: string | null };
      const constraint = (
        stored.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get() as { sql: string }
      ).sql;
      stored.close();

      expect(row.agent_token_id).toBe("t1");
      // The paging cursor every seen_cursors row points at must not be renumbered.
      expect(row.sequence).toBe(7);
      expect(row.entity_title).toBe("Written before a rebuild");
      expect(constraint).toContain("'chapter'");
    });
  });

  describe("the away digest", () => {
    it("shows an agent's work to a teammate but not to the person it acted as", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const { body } = await issue(server);

      // Both people start caught up.
      await server.request("/api/away");
      await loginMember(server);
      await server.request("/api/away");

      await asAgent(server, body.secret, "/api/pages", agentPage("Quietly drafted overnight"));

      const forMaren = (await server.request<AwayState>("/api/away")).body;
      expect(forMaren.total).toBe(1);
      expect(forMaren.events[0]!.entityTitle).toBe("Quietly drafted overnight");
      expect(forMaren.events[0]!.agentName).toBe("Planning agent");

      // The owner's own agent never fills the owner's digest, because the write is theirs.
      await loginOwner(server);
      const forOwner = (await server.request<AwayState>("/api/away")).body;
      expect(forOwner.total).toBe(0);
    });
  });

  describe("the rate limit", () => {
    it("refuses a burst past the bucket and writes nothing for the refused calls", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);

      const attempts = [];
      for (let index = 0; index < 40; index += 1) {
        attempts.push(await asAgent(server, body.secret, "/api/pages", agentPage(`Burst ${index}`)));
      }
      const created = attempts.filter((attempt) => attempt.response.status === 201);
      const refused = attempts.filter((attempt) => attempt.response.status === 429);

      expect(refused.length).toBeGreaterThan(0);
      expect(created.length + refused.length).toBe(40);

      // A refused write leaves nothing behind, so the board matches the accepted count.
      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages).toHaveLength(created.length);
    });

    it("does not meter reads", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { scope: "read" });

      for (let index = 0; index < 40; index += 1) {
        const read = await asAgent(server, body.secret, "/api/board");
        expect(read.response.status).toBe(200);
      }
    });
  });
  describe("what the log says about credentials", () => {
    it("records issue and revoke as agent events, never as project ones", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server);
      await server.request(`/api/agent-tokens/${body.token.id}`, { method: "DELETE" });

      const activity = await server.request<AuditPage>("/api/activity");
      const about = activity.body.events.filter((event) => event.entityTitle === "Planning agent");
      expect(about.length).toBe(2);
      // Borrowing the project entity here would make the digest tell every member the
      // owner created or removed a project, which is alarming and untrue.
      expect(about.every((event) => event.entityType === "agent")).toBe(true);
      expect(about.map((event) => event.action).sort()).toEqual(["created", "removed"]);
    });
  });

  describe("archived projects", () => {
    it("suspends a project's credentials the moment it is archived", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const second = (
        await server.request<{ project: { id: string } }>("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Second project" }),
        })
      ).body.project;
      const issued = await server.request<{ token: AgentToken; secret: string }>(
        `/api/agent-tokens?project=${second.id}`,
        { method: "POST", body: JSON.stringify({ name: "Doomed", scope: "write" }) },
      );

      expect((await asAgent(server, issued.body.secret, "/api/board")).response.status).toBe(200);
      await server.request(`/api/projects/${second.id}`, { method: "DELETE", body: "{}" });

      // Archiving refuses every browser and takes the revoke routes with it, so a
      // credential that stayed alive here would be one no human could ever stop again.
      const read = await asAgent(server, issued.body.secret, "/api/board");
      expect(read.response.status).toBe(401);
      const write = await asAgent(server, issued.body.secret, "/api/pages", agentPage("Into the archive"));
      expect(write.response.status).toBe(401);
    });
  });

  describe("use tracking", () => {
    it("stamps last_used_at on reads, not only writes", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { name: "Reader", scope: "read" });

      await asAgent(server, body.secret, "/api/board");
      const listed = await server.request<{ tokens: AgentToken[] }>("/api/agent-tokens");
      // "Last used" is the signal an owner reads to decide a credential is safe to revoke,
      // so a busy read-only agent must not list as never used.
      expect(listed.body.tokens[0]!.lastUsedAt).not.toBeNull();
    });
  });

  describe("identity for the credential itself", () => {
    it("tells a credential its own name and scope", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const { body } = await issue(server, { name: "Reader", scope: "read" });

      const session = await asAgent(server, body.secret, "/api/session");
      expect(session.body.agent).toEqual({ name: "Reader", scope: "read" });
    });

    it("shows a pinned credential only its own project", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await server.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Second project" }),
      });
      const { body } = await issue(server);

      const board = await asAgent(server, body.secret, "/api/board");
      // The list exists for the project switcher, and a token cannot switch.
      expect(board.body.projects).toHaveLength(1);
      expect(board.body.projects[0].id).toBe(board.body.project.id);

      // A person on the same server still sees both.
      const own = await server.request<BoardWorkspace>("/api/board");
      expect(own.body.projects.length).toBe(2);
    });
  });

  describe("the rate limiter's clock", () => {
    it("survives a wall clock stepping backwards", () => {
      const limiter = new AgentRateLimiter(2, 60);
      expect(limiter.take("t", 1000)).toBe(true);
      // The clock steps back; the remaining burst must survive rather than going negative
      // and locking the credential out for the length of the step.
      expect(limiter.take("t", 500)).toBe(true);
      expect(limiter.take("t", 500)).toBe(false);
      // One second forward refills one write at 60 per minute.
      expect(limiter.take("t", 1500)).toBe(true);
    });
  });

  describe("content preconditions", () => {
    it("compares expectations by their words, not their margins", () => {
      const stored = { title: "Ward the door", description: "  indented body\n" };
      // A body hand-edited on disk keeps its whitespace, while expectations arrive trimmed.
      // The check is about what the words are; margins must not make a page unwritable.
      expect(() =>
        requireUnchangedContent(stored, { expectedDescription: "indented body" }, null, "page"),
      ).not.toThrow();
      expect(() =>
        requireUnchangedContent(stored, { expectedDescription: "different body" }, null, "page"),
      ).toThrow();
    });
  });
});
