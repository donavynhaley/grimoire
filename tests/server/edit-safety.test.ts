import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Idea, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type Server = Awaited<ReturnType<typeof startTestServer>>;

function pagePath(server: Server, pageId: string): string {
  return join(server.pagesDirectory, "getting-started", "pages", `${pageId}.md`);
}

async function createPage(server: Server, title: string, description: string) {
  const created = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  await server.request(`/api/pages/${created.body.page.id}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
  return created.body.page;
}

describe("concurrent edit safety", () => {
  it("refuses a write against notes that already changed, and leaves them intact", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Potion workbench", "The bench holds three reagents.");

    // Someone else rewrites the notes while this editor still holds the old copy.
    await server.request(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Three slots, not four. Do not ship the four-slot version." }),
    });

    const stale = await server.request<{ error: string; conflict: boolean; field: string; current: Page }>(
      `/api/pages/${page.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          description: "The bench holds three reagents. Also add a stir speed.",
          expectedDescription: "The bench holds three reagents.",
        }),
      },
    );

    expect(stale.response.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
    expect(stale.body.field).toBe("description");
    // The refusal carries the stored record, so the editor can show what it collided with.
    expect(stale.body.current.description).toBe("Three slots, not four. Do not ship the four-slot version.");
    expect(readFileSync(pagePath(server, page.id), "utf8")).toContain("Three slots, not four.");
  });

  it("keeps an externally edited body when only the title is rewritten", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Familiar idle loop", "Twelve frames, subtle.");

    // An edit made in Obsidian, or any other editor, straight to the canonical file.
    const path = pagePath(server, page.id);
    const external = `${readFileSync(path, "utf8")}\n- Mara: sixteen frames reads better.\n`;
    writeFileSync(path, external, "utf8");

    const renamed = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Familiar idle breathing loop", expectedTitle: "Familiar idle loop" }),
    });

    expect(renamed.response.status).toBe(200);
    expect(renamed.body.page.title).toBe("Familiar idle breathing loop");
    expect(readFileSync(path, "utf8")).toContain("Mara: sixteen frames reads better.");
  });

  it("lets an untouched field through while a different field is contested", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Cauldron bubbles", "Needs to read over the UI.");

    await server.request(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Second pass is on the branch." }),
    });

    // The notes moved on, but nobody else touched the title, so renaming still works.
    const renamed = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Cauldron bubble VFX pass", expectedTitle: "Cauldron bubbles" }),
    });

    expect(renamed.response.status).toBe(200);
    expect(renamed.body.page.description).toBe("Second pass is on the branch.");
  });

  it("leaves column moves and reordering as last writer wins", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Rain particles", "Low priority.");

    await server.request(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Raised after the playtest." }),
    });

    // A drag carries no content, so it has nothing to lose and no precondition to send.
    const moved = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", position: 0 }),
    });

    expect(moved.response.status).toBe(200);
    expect(moved.body.page.status).toBe("ready");
    expect(moved.body.page.description).toBe("Raised after the playtest.");
  });

  it("refuses a stale idea rewrite the same way", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const created = await server.request<{ idea: Idea }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Familiars learn rituals" }),
    });
    const idea = created.body.idea;
    await server.request(`/api/ideas/${idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Without becoming predictable." }),
    });

    const stale = await server.request<{ conflict: boolean; current: Idea }>(`/api/ideas/${idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Something else entirely.", expectedDescription: "" }),
    });

    expect(stale.response.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
    expect(stale.body.current.description).toBe("Without becoming predictable.");
  });

  it("accepts a rewrite that expects the value actually stored", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const page = await createPage(server, "Save slot corruption", "Reproduces on quick quit.");

    const saved = await server.request<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        description: "Reproduces within 200ms of the autosave toast.",
        expectedDescription: "Reproduces on quick quit.",
      }),
    });

    expect(saved.response.status).toBe(200);
    expect(saved.body.page.description).toBe("Reproduces within 200ms of the autosave toast.");
  });
});
