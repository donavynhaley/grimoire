import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AgentToken, AuditPage, BoardWorkspace, DiscussionThread, Page } from "../../shared/types";
import { parseMentions } from "../../server/discussion";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function makePage(server: TestServer, title = "Swap a logged meal"): Promise<Page> {
  const created = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title, status: "in_progress" }),
  });
  return created.body.page;
}

function ask(server: TestServer, pageId: string, body: string) {
  return server.request<{ thread: DiscussionThread }>(`/api/pages/${pageId}/discussion`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function reply(server: TestServer, pageId: string, threadId: string, body: string) {
  return server.request<{ thread: DiscussionThread }>(`/api/pages/${pageId}/discussion/${threadId}/replies`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function setAnswered(server: TestServer, pageId: string, threadId: string, answered: boolean) {
  return server.request<{ thread: DiscussionThread }>(`/api/pages/${pageId}/discussion/${threadId}/answered`, {
    method: "POST",
    body: JSON.stringify({ answered }),
  });
}

function read(server: TestServer, pageId: string) {
  return server.request<{ threads: DiscussionThread[] }>(`/api/pages/${pageId}/discussion`);
}

/** A request as an agent really makes it: a bearer header and no browser session. */
async function asAgent(server: TestServer, secret: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${server.baseUrl}${path}`, { ...init, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body: body as any };
}

async function issueAgent(server: TestServer, scope: "read" | "write" = "write") {
  const created = await server.request<{ token: AgentToken; secret: string }>("/api/agent-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "Planning agent", scope }),
  });
  return created.body.secret;
}

/** Invites and registers Maren, leaving the session signed in as her. */
async function registerMember(server: TestServer) {
  const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({}) });
  await server.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...MEMBER, inviteCode: invite.body.code }),
  });
}

async function loginMember(server: TestServer) {
  await server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER.email, password: MEMBER.password }),
  });
}

async function loginOwner(server: TestServer) {
  await server.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
  });
}

describe("page discussion", () => {
  describe("threads", () => {
    it("opens a thread and reads it back with its author", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);

      const asked = await ask(server, page.id, "Same-target swaps only, or does the target move too?");
      expect(asked.response.status).toBe(201);
      expect(asked.body.thread.authorName).toBe("Donavyn");
      expect(asked.body.thread.agentName).toBeNull();
      expect(asked.body.thread.answeredAt).toBeNull();
      expect(asked.body.thread.replies).toEqual([]);

      const threads = await read(server, page.id);
      expect(threads.body.threads).toHaveLength(1);
      expect(threads.body.threads[0].body).toBe("Same-target swaps only, or does the target move too?");
    });

    it("keeps replies with their thread, in the order they were written", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const first = (await ask(server, page.id, "Whose clock?")).body.thread;
      await ask(server, page.id, "Does this need a migration?");

      await reply(server, page.id, first.id, "Device time for display.");
      await reply(server, page.id, first.id, "UTC for the ledger.");

      const threads = (await read(server, page.id)).body.threads;
      expect(threads).toHaveLength(2);
      const answered = threads.find((thread) => thread.id === first.id);
      expect(answered?.replies.map((message) => message.body)).toEqual([
        "Device time for display.",
        "UTC for the ledger.",
      ]);
      // The second thread is untouched by the first one's replies.
      expect(threads.find((thread) => thread.id !== first.id)?.replies).toEqual([]);
    });

    it("refuses an empty message and one past the length cap", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);

      expect((await ask(server, page.id, "   ")).response.status).toBe(400);
      expect((await ask(server, page.id, "x".repeat(4001))).response.status).toBe(400);
      expect((await read(server, page.id)).body.threads).toHaveLength(0);
    });

    it("answers 404 for a page that does not exist and a thread that does not", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);

      expect((await read(server, "nope")).response.status).toBe(404);
      expect((await ask(server, "nope", "hello")).response.status).toBe(404);
      expect((await reply(server, page.id, "nope", "hello")).response.status).toBe(404);
      expect((await setAnswered(server, page.id, "nope", true)).response.status).toBe(404);
    });
  });

  describe("open and answered", () => {
    it("marks a thread answered, and reopening clears it again", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Same-target only?")).body.thread;

      const closed = await setAnswered(server, page.id, thread.id, true);
      expect(closed.response.status).toBe(200);
      expect(closed.body.thread.answeredAt).not.toBeNull();
      expect(closed.body.thread.answeredByName).toBe("Donavyn");

      const reopened = await setAnswered(server, page.id, thread.id, false);
      expect(reopened.body.thread.answeredAt).toBeNull();
      expect(reopened.body.thread.answeredById).toBeNull();
      expect(reopened.body.thread.answeredByName).toBeNull();
    });

    it("keeps everything that was said when a thread is answered", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Whose clock?")).body.thread;
      await reply(server, page.id, thread.id, "Device time.");
      await setAnswered(server, page.id, thread.id, true);

      const threads = (await read(server, page.id)).body.threads;
      expect(threads).toHaveLength(1);
      expect(threads[0].replies).toHaveLength(1);
      expect(threads[0].body).toBe("Whose clock?");
    });

    it("counts only unanswered threads onto the page", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const first = (await ask(server, page.id, "One?")).body.thread;
      await ask(server, page.id, "Two?");
      // A reply is not an answer: saying something and having said enough are different claims.
      await reply(server, page.id, first.id, "Something.");

      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages.find((value) => value.id === page.id)?.openThreads).toBe(2);

      await setAnswered(server, page.id, first.id, true);
      const settled = await server.request<BoardWorkspace>("/api/board");
      expect(settled.body.pages.find((value) => value.id === page.id)?.openThreads).toBe(1);

      // A single page read counts for itself rather than reporting zero.
      const one = await server.request<{ page: Page }>(`/api/pages/${page.id}`);
      expect(one.body.page.openThreads).toBe(1);
    });

    it("treats a repeated answer as a no-op rather than a second log line", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Same-target only?")).body.thread;
      await setAnswered(server, page.id, thread.id, true);

      const again = await setAnswered(server, page.id, thread.id, true);
      expect(again.response.status).toBe(200);
      expect(again.body.thread.answeredAt).not.toBeNull();

      const log = await server.request<AuditPage>(`/api/activity?entity=${page.id}`);
      expect(log.body.events.filter((event) => event.action === "answered")).toHaveLength(1);
    });
  });

  describe("the record", () => {
    it("writes discussion into the activity log without putting it in the page", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Same-target only?")).body.thread;
      await reply(server, page.id, thread.id, "Yes, for launch.");
      await setAnswered(server, page.id, thread.id, true);

      const log = await server.request<AuditPage>(`/api/activity?entity=${page.id}`);
      const actions = log.body.events.map((event) => event.action);
      expect(actions).toContain("asked");
      expect(actions).toContain("replied");
      expect(actions).toContain("answered");

      const asked = log.body.events.find((event) => event.action === "asked");
      expect(asked?.changes[0]).toEqual({ field: "said", from: null, to: "Same-target only?" });

      // The notes are untouched: a conversation never edits the page it is about.
      const stored = await server.request<{ page: Page }>(`/api/pages/${page.id}`);
      expect(stored.body.page.description).toBe("");
    });
  });

  describe("who may reach it", () => {
    it("lets a member read and write discussion on a project they are on", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Whose clock?")).body.thread;

      await registerMember(server);
      const replied = await reply(server, page.id, thread.id, "Device time for display.");
      expect(replied.response.status).toBe(201);
      expect(replied.body.thread.replies[0].authorName).toBe("Maren");
      expect((await read(server, page.id)).response.status).toBe(200);
    });

    it("refuses a signed-out request", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);

      const anonymous = await fetch(`${server.baseUrl}/api/pages/${page.id}/discussion`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe("what a review found", () => {
    it("counts what your agent said as unread for you", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const secret = await issueAgent(server);

      await asAgent(server, secret, `/api/pages/${page.id}/discussion`, {
        method: "POST",
        body: JSON.stringify({ body: "Deployed to dev; smoke tests green." }),
      });

      const board = await server.request<BoardWorkspace>("/api/board");
      // A token is a delegation and the write is attributed to Donavyn, but Donavyn has not
      // read it - and an agent reporting is exactly what he most needs telling about.
      expect(board.body.pages.find((value) => value.id === page.id)?.unseenMessages).toBe(1);
    });

    it("still does not count what you wrote yourself", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      await ask(server, page.id, "My own words.");

      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages.find((value) => value.id === page.id)?.unseenMessages).toBe(0);
    });

    it("keeps a message written in the same instant as the seen mark", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Before.")).body.thread;

      await loginMember(server);
      await server.request(`/api/pages/${page.id}/discussion/seen`, { method: "POST", body: JSON.stringify({}) });

      // Force the collision the clock would only occasionally produce.
      const stamp = new Date().toISOString();
      await loginOwner(server);
      await reply(server, page.id, thread.id, "Same millisecond.");
      const database = new DatabaseSync(server.databasePath);
      database.prepare("UPDATE discussion_seen SET seen_at = ?").run(stamp);
      database.prepare("UPDATE page_discussion SET created_at = ? WHERE body = ?").run(stamp, "Same millisecond.");
      database.close();

      await loginMember(server);
      const board = await server.request<BoardWorkspace>("/api/board");
      // The safe direction for a count of what somebody has not read is to count it again.
      expect(board.body.pages.find((value) => value.id === page.id)?.unseenMessages).toBe(1);
    });

    it("names both people who share a display name", () => {
      const twins = [
        { id: "u-one", name: "Alan" },
        { id: "u-two", name: "Alan" },
      ];
      // Guessing which was meant would be worse than telling both.
      expect(parseMentions("@Alan can one of you look?", twins).sort()).toEqual(["u-one", "u-two"]);
    });

    it("does not find a name inside a longer one that is not ASCII", () => {
      const team = [{ id: "u-alan", name: "Alan" }, { id: "u-jose", name: "José" }];
      expect(parseMentions("@Alanè is somebody else", team)).toEqual([]);
      expect(parseMentions("@José can you look?", team)).toEqual(["u-jose"]);
      // And a name is still a name when it follows a letter this alphabet has not heard of.
      expect(parseMentions("é @Alan", team)).toEqual(["u-alan"]);
    });

    it("refuses a reply to a question somebody has already answered", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Settled?")).body.thread;
      await setAnswered(server, page.id, thread.id, true);

      const late = await reply(server, page.id, thread.id, "One more thing.");
      // It would have landed folded away behind the answered count, where nobody would read it.
      expect(late.response.status).toBe(409);
      expect((await read(server, page.id)).body.threads[0].replies).toHaveLength(0);
    });
  });

  describe("agents", () => {
    it("lets a write-scoped agent open a thread, attributed to its issuer", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const secret = await issueAgent(server);

      const posted = await asAgent(server, secret, `/api/pages/${page.id}/discussion`, {
        method: "POST",
        body: JSON.stringify({ body: "Deployed to dev; smoke tests green. Nothing needed from you." }),
      });
      expect(posted.response.status).toBe(201);
      // The person stays the author; the agent is named beside them, never instead of them.
      expect(posted.body.thread.authorName).toBe("Donavyn");
      expect(posted.body.thread.agentName).toBe("Planning agent");
    });

    it("lets an agent reply to a thread a person opened", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Did the migration run?")).body.thread;
      const secret = await issueAgent(server);

      const replied = await asAgent(server, secret, `/api/pages/${page.id}/discussion/${thread.id}/replies`, {
        method: "POST",
        body: JSON.stringify({ body: "It ran at 09:14 and moved 412 rows." }),
      });
      expect(replied.response.status).toBe(201);
      expect(replied.body.thread.replies[0].agentName).toBe("Planning agent");
    });

    it("lets an agent read the discussion it was asked about", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      await ask(server, page.id, "Can you check whether the reducer is shared?");
      const secret = await issueAgent(server, "read");

      const seen = await asAgent(server, secret, `/api/pages/${page.id}/discussion`);
      expect(seen.response.status).toBe(200);
      expect(seen.body.threads[0].body).toBe("Can you check whether the reducer is shared?");
    });

    it("never lets an agent close a thread, whatever its scope", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Same-target only?")).body.thread;
      const secret = await issueAgent(server);

      const refused = await asAgent(server, secret, `/api/pages/${page.id}/discussion/${thread.id}/answered`, {
        method: "POST",
        body: JSON.stringify({ answered: true }),
      });
      expect(refused.response.status).toBe(403);

      await loginOwner(server);
      expect((await read(server, page.id)).body.threads[0].answeredAt).toBeNull();
    });

    it("refuses a read-only credential trying to say anything", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const secret = await issueAgent(server, "read");

      const refused = await asAgent(server, secret, `/api/pages/${page.id}/discussion`, {
        method: "POST",
        body: JSON.stringify({ body: "Anything at all." }),
      });
      expect(refused.response.status).toBe(403);
    });
  });

  describe("naming somebody", () => {
    const TEAM = [
      { id: "u-alan", name: "Alan" },
      { id: "u-maren", name: "Maren Voss" },
      { id: "u-alanis", name: "Alanis" },
    ];

    it("finds a name that was named", () => {
      expect(parseMentions("@Alan can you look?", TEAM)).toEqual(["u-alan"]);
      expect(parseMentions("ask @Alan about it", TEAM)).toEqual(["u-alan"]);
      expect(parseMentions("ask @Alan.", TEAM)).toEqual(["u-alan"]);
    });

    it("reads a name with a space in it as one name", () => {
      // Longest first, so this is Maren Voss rather than Maren with a stray surname after it.
      expect(parseMentions("@Maren Voss and nobody else", TEAM)).toEqual(["u-maren"]);
    });

    it("does not mistake a longer name for a shorter one", () => {
      expect(parseMentions("@Alanis wrote this", TEAM)).toEqual(["u-alanis"]);
    });

    it("ignores an address and a name nobody has", () => {
      expect(parseMentions("mail alan@example.com about it", TEAM)).toEqual([]);
      expect(parseMentions("@Nobody is on this project", TEAM)).toEqual([]);
    });

    it("names somebody once however many times they are written", () => {
      expect(parseMentions("@Alan and @Alan again", TEAM)).toEqual(["u-alan"]);
    });

    it("does not care about case", () => {
      expect(parseMentions("@alan", TEAM)).toEqual(["u-alan"]);
    });
  });

  describe("mentions on a message", () => {
    it("records who was named, and says so on the way back", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const page = await makePage(server);

      const asked = await ask(server, page.id, "@Maren does this need a migration?");
      expect(asked.body.thread.mentions).toHaveLength(1);

      const threads = (await read(server, page.id)).body.threads;
      expect(threads[0].mentions).toEqual(asked.body.thread.mentions);
      // The text keeps what was typed; only who was meant is stored beside it.
      expect(threads[0].body).toBe("@Maren does this need a migration?");
    });

    it("counts a mention as unread news of its own", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const page = await makePage(server);
      await ask(server, page.id, "Nobody in particular.");
      await ask(server, page.id, "@Maren this one is for you.");

      await loginMember(server);
      const board = await server.request<BoardWorkspace>("/api/board");
      const seen = board.body.pages.find((value) => value.id === page.id);
      // Two unread, one of which named her.
      expect(seen?.unseenMessages).toBe(2);
      expect(seen?.unseenMentions).toBe(1);
    });

    it("never counts you naming yourself", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      await ask(server, page.id, "@Donavyn talking to myself.");

      const board = await server.request<BoardWorkspace>("/api/board");
      const seen = board.body.pages.find((value) => value.id === page.id);
      expect(seen?.unseenMentions).toBe(0);
    });

    it("clears with everything else once the conversation has been read", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const page = await makePage(server);
      await ask(server, page.id, "@Maren over to you.");

      await loginMember(server);
      await server.request(`/api/pages/${page.id}/discussion/seen`, { method: "POST", body: JSON.stringify({}) });
      const board = await server.request<BoardWorkspace>("/api/board");
      expect(board.body.pages.find((value) => value.id === page.id)?.unseenMentions).toBe(0);
    });

    it("lets an agent name somebody too", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await registerMember(server);
      await loginOwner(server);
      const page = await makePage(server);
      const secret = await issueAgent(server);

      const posted = await asAgent(server, secret, `/api/pages/${page.id}/discussion`, {
        method: "POST",
        body: JSON.stringify({ body: "@Maren the migration ran; nothing needed from you." }),
      });
      expect(posted.response.status).toBe(201);
      expect(posted.body.thread.mentions).toHaveLength(1);
    });
  });

  describe("what has not been read", () => {
    function seen(server: TestServer, pageId: string) {
      return server.request<{ ok: boolean }>(`/api/pages/${pageId}/discussion/seen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }

    async function unseenFor(server: TestServer, pageId: string): Promise<number> {
      const board = await server.request<BoardWorkspace>("/api/board");
      return board.body.pages.find((value) => value.id === pageId)?.unseenMessages ?? -1;
    }

    it("does not count what you wrote yourself", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      await ask(server, page.id, "Something I said.");

      expect(await unseenFor(server, page.id)).toBe(0);
    });

    it("counts everything on a page you have never opened", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Whose clock?")).body.thread;
      await reply(server, page.id, thread.id, "Device time.");

      await registerMember(server);
      // Maren has never looked at this page, so the question and its reply are both new to her.
      expect(await unseenFor(server, page.id)).toBe(2);
    });

    it("clears once the conversation has been opened, and counts again after that", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const thread = (await ask(server, page.id, "Whose clock?")).body.thread;

      await registerMember(server);
      expect(await unseenFor(server, page.id)).toBe(1);
      expect((await seen(server, page.id)).response.status).toBe(200);
      expect(await unseenFor(server, page.id)).toBe(0);

      await loginOwner(server);
      await reply(server, page.id, thread.id, "Device time for display.");

      await loginMember(server);
      // Only what arrived after she looked.
      expect(await unseenFor(server, page.id)).toBe(1);
    });

    it("is private to each person", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      await ask(server, page.id, "Whose clock?");

      await registerMember(server);
      await seen(server, page.id);
      expect(await unseenFor(server, page.id)).toBe(0);

      await loginOwner(server);
      // Donavyn wrote it, so it was never unread for him - and Maren reading it changed
      // nothing about his own count either way.
      expect(await unseenFor(server, page.id)).toBe(0);

      await loginMember(server);
      await loginOwner(server);
      const secondPage = await makePage(server, "Another page");
      await loginMember(server);
      await ask(server, secondPage.id, "And this one?");
      await loginOwner(server);
      expect(await unseenFor(server, secondPage.id)).toBe(1);
      await loginMember(server);
      expect(await unseenFor(server, secondPage.id)).toBe(0);
    });

    it("answers 404 for a page that is not there", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      expect((await seen(server, "nope")).response.status).toBe(404);
    });

    it("is closed to an agent, which has no attention to spend", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const page = await makePage(server);
      const secret = await issueAgent(server);

      const refused = await asAgent(server, secret, `/api/pages/${page.id}/discussion/seen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(refused.response.status).toBe(403);
    });
  });
});
