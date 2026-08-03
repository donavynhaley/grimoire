import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoardWorkspace, Card } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function board(server: Awaited<ReturnType<typeof startTestServer>>) {
  return (await server.request<BoardWorkspace>("/api/board")).body;
}

describe("card board", () => {
  it("returns only the project identity, people, and cards", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const workspace = await board(server);

    expect(Object.keys(workspace).sort()).toEqual(["cards", "currentUser", "members", "project"]);
    expect(workspace.project).toEqual(expect.objectContaining({ name: "Wizard Simulator" }));
    expect(workspace.cards).toEqual(expect.any(Array));
    expect(workspace).not.toHaveProperty("pillars");
    expect(workspace).not.toHaveProperty("milestones");
  });

  it("creates, assigns, edits, and archives a card", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const workspace = await board(server);

    const created = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Block out the potion workbench", assigneeId: workspace.currentUser.id }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.card).toMatchObject({
      title: "Block out the potion workbench",
      status: "backlog",
      assigneeName: "Donavyn",
      position: 0,
    });

    const updated = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Keep it readable from the doorway.", assigneeId: null }),
    });
    expect(updated.body.card).toMatchObject({
      description: "Keep it readable from the doorway.",
      assigneeId: null,
    });

    const archived = await server.request(`/api/cards/${created.body.card.id}`, { method: "DELETE" });
    expect(archived.response.status).toBe(200);
    expect((await board(server)).cards.map((card) => card.id)).not.toContain(created.body.card.id);
  });

  it("moves and reorders cards using their drop position", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const first = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "First card" }),
    });
    const second = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Second card" }),
    });

    const moved = await server.request<{ card: Card }>(`/api/cards/${second.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress", position: 0 }),
    });
    expect(moved.body.card).toMatchObject({ status: "in_progress", position: 0 });

    await server.request(`/api/cards/${first.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress", position: 0 }),
    });
    const inProgress = (await board(server)).cards.filter((card) => card.status === "in_progress");
    expect(inProgress.map((card) => card.title)).toEqual(["First card", "Second card"]);
    expect(inProgress.map((card) => card.position)).toEqual([0, 1]);
  });

  it("persists cards after the server restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-board-persistence-"));
    directories.push(directory);
    const first = await startTestServer(directory);
    await bootstrap(first);
    await first.request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Give the cauldron a readable boil state", status: "ready" }),
    });
    await first.close();

    const second = await startTestServer(directory);
    await second.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect((await board(second)).cards.map((card) => card.title)).toContain(
      "Give the cauldron a readable boil state",
    );
  });
});
