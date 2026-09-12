import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEMO_STORAGE_KEY } from "../../src/demo/mode";
import { DemoStore } from "../../src/demo/store";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function call(store: DemoStore, path: string, method = "GET", body: unknown = {}) {
  return store.request(path, method, body, null);
}
function createPage(store: DemoStore, title = "A visitor's page") {
  return z
    .object({ page: z.object({ id: z.string() }) })
    .parse(call(store, "/api/pages", "POST", { title, status: "ready" })).page.id;
}
describe("the browser demo owns its own work", () => {
  it("creates, edits, moves, archives and restores a page across reloads", () => {
    const storage = memoryStorage();
    const store = new DemoStore(storage);
    const id = createPage(store);
    call(store, `/api/pages/${id}`, "PATCH", { description: "My notes", status: "in_progress" });
    const restored = new DemoStore(storage);
    expect(call(restored, `/api/pages/${id}`)).toMatchObject({
      page: { description: "My notes", status: "in_progress" },
    });
    call(restored, `/api/pages/${id}`, "DELETE");
    expect(call(restored, "/api/search?q=visitor")).toMatchObject({
      hits: expect.arrayContaining([expect.objectContaining({ id, group: "archived" })]),
    });
    call(restored, `/api/pages/${id}/restore`, "POST");
    expect(call(restored, `/api/pages/${id}`)).toMatchObject({ page: { description: "My notes" } });
  });
  it("refuses stale content and cyclic dependencies without partially saving", () => {
    const store = new DemoStore(memoryStorage());
    const first = createPage(store, "First");
    const second = createPage(store, "Second");
    call(store, `/api/pages/${first}`, "PATCH", { blockedBy: [second] });
    expect(() =>
      call(store, `/api/pages/${second}`, "PATCH", { title: "Wrong", blockedBy: [first] }),
    ).toThrow(/cycle/);
    expect(call(store, `/api/pages/${second}`)).toMatchObject({ page: { title: "Second", blockedBy: [] } });
    expect(() =>
      call(store, `/api/pages/${first}`, "PATCH", { title: "Overwrite", expectedTitle: "Old" }),
    ).toThrow(/changed/);
  });
  it("keeps a discussion and its answered state after refresh", () => {
    const storage = memoryStorage();
    const store = new DemoStore(storage);
    const id = createPage(store);
    const { thread } = z
      .object({ thread: z.object({ id: z.string() }) })
      .parse(call(store, `/api/pages/${id}/discussion`, "POST", { body: "Any thoughts?" }));
    call(store, `/api/pages/${id}/discussion/${thread.id}/replies`, "POST", { body: "Looks good." });
    call(store, `/api/pages/${id}/discussion/${thread.id}/answered`, "POST", { answered: true });
    expect(call(new DemoStore(storage), `/api/pages/${id}/discussion`)).toMatchObject({
      threads: [{ answeredByName: "Alex", replies: [{ body: "Looks good." }] }],
    });
  });
  it("can promote an idea and undo that promotion", () => {
    const store = new DemoStore(memoryStorage());
    const { idea } = z
      .object({ idea: z.object({ id: z.string() }) })
      .parse(call(store, "/api/ideas", "POST", { title: "A new direction" }));
    call(store, `/api/ideas/${idea.id}/promote`, "POST");
    expect(call(store, "/api/search?q=new%20direction")).toMatchObject({ hits: [{ kind: "page" }] });
    call(store, `/api/ideas/${idea.id}/promotion`, "DELETE");
    expect(call(store, "/api/search?q=new%20direction")).toMatchObject({ hits: [{ kind: "idea" }] });
  });
  it("lets the owner change definitions and removes deleted references", () => {
    const store = new DemoStore(memoryStorage());
    const id = createPage(store);
    const { category } = z
      .object({ category: z.object({ slug: z.string() }) })
      .parse(call(store, "/api/categories", "POST", { name: "Testing", color: "#b8d99b" }));
    const { field } = z
      .object({ field: z.object({ key: z.string() }) })
      .parse(
        call(store, "/api/fields", "POST", { label: "Urgency", type: "select", options: ["Soon", "Later"] }),
      );
    call(store, `/api/pages/${id}`, "PATCH", { category: category.slug, fields: { [field.key]: "Soon" } });
    call(store, `/api/categories/${category.slug}`, "DELETE");
    call(store, `/api/fields/${field.key}`, "DELETE");
    expect(call(store, `/api/pages/${id}`)).toMatchObject({ page: { category: null, fields: {} } });
  });
  it("records chapter delivery and rolls unfinished work into the next chapter", () => {
    const store = new DemoStore(memoryStorage());
    const chapterShape = z.object({ chapter: z.object({ slug: z.string() }) });
    const first = chapterShape.parse(call(store, "/api/chapters", "POST", { name: "First", state: "open" }))
      .chapter.slug;
    const next = chapterShape.parse(call(store, "/api/chapters", "POST", { name: "Next" })).chapter.slug;
    const id = createPage(store);
    call(store, `/api/pages/${id}`, "PATCH", { chapter: first });
    expect(call(store, `/api/chapters/${first}/close`, "POST", { rollover: "next" })).toMatchObject({
      chapter: { state: "closed", carriedPages: 1, deliveredPages: 0 },
    });
    expect(call(store, `/api/pages/${id}`)).toMatchObject({ page: { chapter: next } });
  });
  it("creates and archives projects locally", () => {
    const store = new DemoStore(memoryStorage());
    const { project } = z
      .object({ project: z.object({ id: z.string() }) })
      .parse(call(store, "/api/projects", "POST", { name: "Another project" }));
    call(store, `/api/projects/${project.id}`, "PATCH", { name: "Renamed" });
    call(store, `/api/projects/${project.id}`, "DELETE");
    expect(call(store, "/api/projects/archived")).toMatchObject({ projects: [{ name: "Renamed" }] });
    call(store, `/api/projects/${project.id}/restore`, "POST");
    expect(call(store, "/api/projects/archived")).toEqual({ projects: [] });
  });
  it("has a closed route policy including unknown reads and external integrations", () => {
    const store = new DemoStore(memoryStorage());
    for (const path of [
      "/api/not-yet-implemented",
      "/api/auth/login",
      "/api/auth/bootstrap",
      "/api/auth/logout",
      "/api/invites",
      "/api/agent-tokens",
      "/api/auth/oidc/probe",
      "/api/github/verify",
      "https://example.com/api/pages",
    ]) {
      expect(() => call(store, path, "POST", { password: "not-a-real-secret" })).toThrow();
    }
    expect(() => call(store, "/api/not-yet-implemented")).toThrow();
    expect(() => call(store, "/api/categories/feature/unknown", "PATCH", { name: "Changed" })).toThrow();
    expect(() => call(store, "/api/pages/unknown/restore/unknown", "POST")).toThrow();
    expect(call(store, "/api/session")).toMatchObject({ status: "authenticated", user: { name: "Alex" } });
  });
  it("reset clears only demo storage and gives the visitor fresh seed data", () => {
    const storage = memoryStorage();
    storage.setItem("real-preference", "keep");
    const store = new DemoStore(storage);
    createPage(store, "Local experiment");
    store.reset();
    expect(call(store, "/api/search?q=experiment")).toMatchObject({ total: 0 });
    expect(storage.getItem("real-preference")).toBe("keep");
    expect(call(new DemoStore(memoryStorage()), "/api/search?q=experiment")).toMatchObject({ total: 0 });
  });
  it("recovers from invalid, outdated and tampered saved commands", () => {
    for (const saved of [
      "{broken",
      JSON.stringify({ version: 0, commands: [] }),
      JSON.stringify({
        version: 1,
        commands: [
          {
            path: "/api/auth/bootstrap",
            method: "POST",
            body: {},
            project: null,
            at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ]) {
      const storage = memoryStorage();
      storage.setItem(DEMO_STORAGE_KEY, saved);
      expect(call(new DemoStore(storage), "/api/board")).toMatchObject({
        project: { name: "The Lantern Workshop" },
        viewerIsOwner: true,
      });
      expect(storage.getItem(DEMO_STORAGE_KEY)).toBeNull();
    }
  });
  it("keeps working in memory when browser storage refuses writes", () => {
    const store = new DemoStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    const id = createPage(store);
    expect(call(store, `/api/pages/${id}`)).toMatchObject({ page: { title: "A visitor's page" } });
  });
});

it("uses the same search window and archived scope as the server", () => {
  const store = new DemoStore(memoryStorage());
  for (let index = 0; index < 40; index += 1) {
    const id = createPage(store, `Current ${index}`);
    call(store, `/api/pages/${id}`, "PATCH", { description: "mentions recoveryneedle" });
  }
  const id = createPage(store, "recoveryneedle");
  call(store, `/api/pages/${id}`, "DELETE");
  expect(call(store, "/api/search?q=recoveryneedle")).toMatchObject({
    total: 41,
    nextOffset: 40,
    hits: [
      expect.objectContaining({ id, group: "archived" }),
      ...Array.from({ length: 39 }, () => expect.anything()),
    ],
  });
  expect(call(store, "/api/search?q=recoveryneedle&offset=40")).toMatchObject({
    total: 41,
    hits: [expect.anything()],
  });
  expect(call(store, "/api/search?scope=archived")).toMatchObject({
    hits: [expect.objectContaining({ id })],
  });
});
