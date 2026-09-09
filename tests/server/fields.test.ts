import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToken, AuditPage, BoardWorkspace, Page, ProjectField } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const MEMBER = { name: "Maren", email: "maren@example.com", password: "a long enough password" };

async function defineField(server: TestServer, body: Record<string, unknown>) {
  return server.request<{ field: ProjectField }>("/api/fields", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function priority(server: TestServer) {
  const { body } = await defineField(server, {
    label: "Priority",
    type: "select",
    options: ["p0", "p1", "p2", "p3"],
    showOnTile: true,
  });
  return body.field;
}

async function createPage(server: TestServer, body: Record<string, unknown>) {
  return server.request<{ page: Page }>("/api/pages", { method: "POST", body: JSON.stringify(body) });
}

async function board(server: TestServer) {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

/** The page file as it actually sits on disk, which is where the values really live. */
function pageFile(server: TestServer, slug = "getting-started"): string {
  const directory = join(server.pagesDirectory, slug, "pages");
  const [file] = readdirSync(directory).filter((name) => name.endsWith(".md"));
  return readFileSync(join(directory, file!), "utf8");
}

describe("custom page fields", () => {
  describe("defining them", () => {
    it("starts a project with none, and keeps page files unchanged until one is filled in", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      expect((await board(server)).fields).toEqual([]);

      await createPage(server, { title: "A page with no fields" });
      expect(pageFile(server)).not.toContain("fields:");
    });

    it("keys a field off its label and offers it on the board", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);

      expect(field).toEqual({
        key: "priority",
        label: "Priority",
        type: "select",
        options: ["p0", "p1", "p2", "p3"],
        position: 0,
        showOnTile: true,
      });
      expect((await board(server)).fields).toEqual([field]);
    });

    it("refuses a second field with the same name, and a choice field with no options", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);

      expect((await defineField(server, { label: "Priority", type: "text" })).response.status).toBe(409);
      expect((await defineField(server, { label: "Risk", type: "select" })).response.status).toBe(400);
      expect(
        (await defineField(server, { label: "Risk", type: "select", options: [] })).response.status,
      ).toBe(400);
      expect((await defineField(server, { label: "!!!", type: "text" })).response.status).toBe(400);
    });

    it("treats a searchable choice as a choice: options required, values checked against them", async () => {
      const server = await startTestServer();
      await bootstrap(server);

      // No options, no field - same refusal the plain choice gets.
      expect((await defineField(server, { label: "Zone", type: "search-select" })).response.status).toBe(400);

      const made2 = await defineField(server, {
        label: "Zone",
        type: "search-select",
        options: ["coast", "forest", "peaks"],
      });
      expect(made2.body.field.type).toBe("search-select");

      const made = await createPage(server, { title: "Chart the coast", fields: { zone: "coast" } });
      expect(made.response.status).toBe(201);
      expect(made.body.page.fields).toEqual({ zone: "coast" });

      // A value outside the list is refused, exactly as a plain choice refuses it.
      const refused = await createPage(server, { title: "Nowhere", fields: { zone: "swamp" } });
      expect(refused.response.status).toBe(400);
    });

    it("swaps a choice field between its two presentations without touching a stored value", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      const made = await createPage(server, { title: "Ship it", fields: { priority: "p1" } });
      expect(made.response.status).toBe(201);

      const swapped = await server.request<{ field: ProjectField; cleared: number }>(
        `/api/fields/${field.key}`,
        {
          method: "PATCH",
          body: JSON.stringify({ type: "search-select" }),
        },
      );
      expect(swapped.response.status).toBe(200);
      expect(swapped.body.field.type).toBe("search-select");
      expect(swapped.body.field.options).toEqual(["p0", "p1", "p2", "p3"]);
      // The point of allowing this one swap: nothing already written is disturbed by it.
      expect(swapped.body.cleared).toBe(0);
      expect(pageFile(server)).toContain("p1");
      expect((await board(server)).pages[0]!.fields).toEqual({ priority: "p1" });

      // And back again, because which one reads better is a judgement a team may revisit.
      const back = await server.request<{ field: ProjectField }>(`/api/fields/${field.key}`, {
        method: "PATCH",
        body: JSON.stringify({ type: "select" }),
      });
      expect(back.body.field.type).toBe("select");
      expect((await board(server)).pages[0]!.fields).toEqual({ priority: "p1" });
    });

    it.each(["text", "number", "date", "checkbox"])(
      "refuses changing a choice field to %s and preserves its stored value",
      async (type) => {
        const server = await startTestServer();
        await bootstrap(server);
        const field = await priority(server);
        await createPage(server, { title: "Ship it", fields: { priority: "p1" } });

        const refused = await server.request(`/api/fields/${field.key}`, {
          method: "PATCH",
          body: JSON.stringify({ type }),
        });
        expect(refused.response.status).toBe(400);
        const unchanged = await board(server);
        expect(unchanged.fields[0]!.type).toBe("select");
        expect(unchanged.pages[0]!.fields).toEqual({ priority: "p1" });
      },
    );

    it("records the swap in the audit trail, so a changed control has a reason on it", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      await server.request(`/api/fields/${field.key}`, {
        method: "PATCH",
        body: JSON.stringify({ type: "search-select" }),
      });

      const activity = await server.request<AuditPage>("/api/activity");
      const entry = activity.body.events.find(
        (event) => event.entityType === "field" && event.action === "updated",
      );
      expect(entry?.changes).toContainEqual({ field: "type", from: "select", to: "search-select" });
    });

    it("is owner-only, because deciding what the project records is restructuring it", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: "{}" });
      await server.request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ ...MEMBER, inviteCode: invite.body.code }),
      });

      expect((await defineField(server, { label: "Priority", type: "text" })).response.status).toBe(403);
    });
  });

  describe("filling them in", () => {
    it("writes values into the page's own file, and serves them on the board", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);
      await defineField(server, { label: "Estimate", type: "number" });

      const created = await createPage(server, {
        title: "Reconcile the backlog",
        fields: { priority: "p0", estimate: 3 },
      });
      expect(created.body.page.fields).toEqual({ priority: "p0", estimate: 3 });
      expect(pageFile(server)).toContain('fields: {"priority":"p0","estimate":3}');

      const [page] = (await board(server)).pages;
      expect(page!.fields).toEqual({ priority: "p0", estimate: 3 });
    });

    it("treats an update as a patch, so setting one value never blanks the others", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);
      await defineField(server, { label: "Estimate", type: "number" });
      const page = (
        await createPage(server, {
          title: "Reconcile the backlog",
          fields: { priority: "p2", estimate: 5 },
        })
      ).body.page;

      const patched = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: { priority: "p0" } }),
      });
      expect(patched.body.page.fields).toEqual({ priority: "p0", estimate: 5 });

      // null is how a caller clears one, and clearing drops the key rather than storing a blank.
      const cleared = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: { estimate: null } }),
      });
      expect(cleared.body.page.fields).toEqual({ priority: "p0" });
      expect(pageFile(server)).toContain('fields: {"priority":"p0"}');
    });

    it("refuses a value the field does not accept, and a field the project never defined", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);
      await defineField(server, { label: "Estimate", type: "number" });
      await defineField(server, { label: "Due", type: "date" });
      await defineField(server, { label: "Blocked", type: "checkbox" });

      const refusals: Array<[string, Record<string, unknown>]> = [
        ["an option that is not offered", { priority: "urgent" }],
        ["text where a number belongs", { estimate: "three" }],
        ["a timestamp where a day belongs", { due: "2026-08-16T00:00:00.000Z" }],
        ["a string where a checkbox belongs", { blocked: "yes" }],
        ["a field nobody defined", { velocity: 12 }],
      ];

      for (const [reason, fields] of refusals) {
        const attempt = await createPage(server, { title: `Refused: ${reason}`, fields });
        expect(attempt.response.status, reason).toBe(400);
      }
      expect((await board(server)).pages).toHaveLength(0);
    });

    it("names each moved field in the activity log, by its label", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);
      const page = (await createPage(server, { title: "Reconcile the backlog", fields: { priority: "p2" } }))
        .body.page;
      await server.request(`/api/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: { priority: "p0" } }),
      });

      const { body } = await server.request<AuditPage>("/api/activity");
      const update = body.events.find((event) => event.action === "updated" && event.entityType === "page");
      expect(update?.changes).toEqual([{ field: "Priority", from: "p2", to: "p0" }]);
    });
  });

  describe("changing a definition after the fact", () => {
    it("clears values whose option was withdrawn, and says how many", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      await createPage(server, { title: "Still valid", fields: { priority: "p0" } });
      await createPage(server, { title: "About to be cleared", fields: { priority: "p3" } });

      const narrowed = await server.request<{ field: ProjectField; cleared: number }>(
        `/api/fields/${field.key}`,
        {
          method: "PATCH",
          body: JSON.stringify({ options: ["p0", "p1"] }),
        },
      );
      expect(narrowed.body.cleared).toBe(1);

      const pages = (await board(server)).pages;
      expect(pages.find((page) => page.title === "Still valid")?.fields).toEqual({ priority: "p0" });
      expect(pages.find((page) => page.title === "About to be cleared")?.fields).toEqual({});
    });

    it("takes the values with it when the field is deleted", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      await createPage(server, { title: "Reconcile the backlog", fields: { priority: "p0" } });

      const removed = await server.request<{ cleared: number }>(`/api/fields/${field.key}`, {
        method: "DELETE",
      });
      expect(removed.body.cleared).toBe(1);
      expect((await board(server)).fields).toEqual([]);
      expect((await board(server)).pages[0]!.fields).toEqual({});
      expect(pageFile(server)).not.toContain("fields:");
    });

    it("renames without disturbing the values, because the key is what pages point at", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      await createPage(server, { title: "Reconcile the backlog", fields: { priority: "p0" } });

      const renamed = await server.request<{ field: ProjectField }>(`/api/fields/${field.key}`, {
        method: "PATCH",
        body: JSON.stringify({ label: "Urgency" }),
      });
      expect(renamed.body.field).toEqual(expect.objectContaining({ key: "priority", label: "Urgency" }));
      expect((await board(server)).pages[0]!.fields).toEqual({ priority: "p0" });
    });
  });

  describe("what an agent may do with them", () => {
    it("fills fields in and reads them back, but never defines or deletes one", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      const field = await priority(server);
      const issued = await server.request<{ token: AgentToken; secret: string }>("/api/agent-tokens", {
        method: "POST",
        body: JSON.stringify({ name: "Planning agent", scope: "write" }),
      });
      const asAgent = (path: string, init: RequestInit = {}) =>
        fetch(`${server.baseUrl}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${issued.body.secret}`, "content-type": "application/json" },
        });

      const created = await asAgent("/api/pages", {
        method: "POST",
        body: JSON.stringify({ title: "Written by an agent", fields: { priority: "p1" } }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).page.fields).toEqual({ priority: "p1" });

      // Defining the shape of the project stays with a person, whatever the token's scope.
      expect(
        (
          await asAgent("/api/fields", {
            method: "POST",
            body: JSON.stringify({ label: "Velocity", type: "number" }),
          })
        ).status,
      ).toBe(403);
      expect((await asAgent(`/api/fields/${field.key}`, { method: "DELETE" })).status).toBe(403);
      expect(
        (
          await asAgent(`/api/fields/${field.key}`, {
            method: "PATCH",
            body: JSON.stringify({ label: "Urgency" }),
          })
        ).status,
      ).toBe(403);
    });
  });

  describe("the file on disk", () => {
    it("round-trips values through a restart, since the Markdown is the record", async () => {
      const server = await startTestServer();
      await bootstrap(server);
      await priority(server);
      await defineField(server, { label: "Blocked", type: "checkbox" });
      await createPage(server, {
        title: "Reconcile the backlog",
        fields: { priority: "p0", blocked: true },
      });

      // A second server over the same directory reads the files rather than any memory of them.
      const reopened = await startTestServer(server.pagesDirectory.replace(/\/pages$/, ""));
      await reopened.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
      });
      const pages = (await reopened.request<BoardWorkspace>("/api/board")).body.pages;
      expect(pages[0]!.fields).toEqual({ priority: "p0", blocked: true });
    });
  });
});
