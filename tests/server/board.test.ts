import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    const activePath = join(
      server.cardsDirectory,
      "wizard-simulator",
      "cards",
      `${created.body.card.id}.md`,
    );
    const markdown = readFileSync(activePath, "utf8");
    expect(markdown).toMatch(/^---\n/);
    expect(markdown).toContain(`id: ${created.body.card.id}`);
    expect(markdown).toContain("title: Block out the potion workbench");
    expect(markdown).toContain("assignee: owner@example.com");

    const updated = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Keep it readable from the doorway.", assigneeId: null }),
    });
    expect(updated.body.card).toMatchObject({
      description: "Keep it readable from the doorway.",
      assigneeId: null,
    });
    expect(readFileSync(activePath, "utf8")).toContain("\n---\n\nKeep it readable from the doorway.\n");

    writeFileSync(
      activePath,
      readFileSync(activePath, "utf8")
        .replace("title: Block out the potion workbench", "title: Polish the potion workbench")
        .replace("Keep it readable from the doorway.", "This note was edited outside Grimoire."),
    );
    expect((await board(server)).cards[0]).toMatchObject({
      title: "Polish the potion workbench",
      description: "This note was edited outside Grimoire.",
    });

    const archived = await server.request(`/api/cards/${created.body.card.id}`, { method: "DELETE" });
    expect(archived.response.status).toBe(200);
    expect((await board(server)).cards.map((card) => card.id)).not.toContain(created.body.card.id);
    expect(existsSync(activePath)).toBe(false);
    expect(
      existsSync(join(server.cardsDirectory, "wizard-simulator", "archive", `${created.body.card.id}.md`)),
    ).toBe(true);

    const restored = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}/restore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(restored.response.status).toBe(200);
    expect(restored.body.card).toMatchObject({ id: created.body.card.id, title: "Polish the potion workbench" });
    expect((await board(server)).cards.map((card) => card.id)).toContain(created.body.card.id);
    expect(existsSync(activePath)).toBe(true);
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

  it("holds work in review without marking it complete", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const created = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Check the wand polish pass", status: "in_progress" }),
    });

    const reviewed = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "review", position: 0 }),
    });
    expect(reviewed.response.status).toBe(200);
    expect(reviewed.body.card).toMatchObject({ status: "review", position: 0, completedAt: null });
    const markdown = readFileSync(
      join(server.cardsDirectory, "wizard-simulator", "cards", `${created.body.card.id}.md`),
      "utf8",
    );
    expect(markdown).toContain("status: review");

    const completed = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    expect(completed.body.card.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records completion once and clears it when work is reopened", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const created = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Finish the first potion recipe", status: "ready" }),
    });
    expect(created.body.card.completedAt).toBeNull();

    const completed = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    expect(completed.body.card.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const completedAt = completed.body.card.completedAt;

    const edited = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Keep the result in the project history." }),
    });
    expect(edited.body.card.completedAt).toBe(completedAt);

    const reopened = await server.request<{ card: Card }>(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready" }),
    });
    expect(reopened.body.card.completedAt).toBeNull();
    const markdown = readFileSync(
      join(server.cardsDirectory, "wizard-simulator", "cards", `${created.body.card.id}.md`),
      "utf8",
    );
    expect(markdown).toContain("completed_at: null");
  });

  it("categorizes cards and derives blocking from other active cards", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const blocker = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Model the ritual table", category: "modeling" }),
    });
    const dependent = await server.request<{ card: Card }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Texture the ritual table", category: "texturing" }),
    });

    const linked = await server.request<{ card: Card }>(`/api/cards/${dependent.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ blockedBy: [blocker.body.card.id] }),
    });

    expect(linked.response.status).toBe(200);
    expect(linked.body.card).toMatchObject({ category: "texturing", blockedBy: [blocker.body.card.id] });
    const markdown = readFileSync(
      join(server.cardsDirectory, "wizard-simulator", "cards", `${dependent.body.card.id}.md`),
      "utf8",
    );
    expect(markdown).toContain("category: texturing");
    expect(markdown).toContain(`blocked_by: ["${blocker.body.card.id}"]`);

    const cycle = await server.request(`/api/cards/${blocker.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ blockedBy: [dependent.body.card.id] }),
    });
    expect(cycle.response.status).toBe(400);
    expect(cycle.body).toEqual({ error: "Card dependencies cannot form a cycle" });

    const archive = await server.request(`/api/cards/${blocker.body.card.id}`, { method: "DELETE" });
    expect(archive.response.status).toBe(409);
    expect(archive.body).toEqual({ error: "This card blocks active work and cannot be archived" });

    await server.request(`/api/cards/${blocker.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    const finished = await board(server);
    expect(finished.cards.find((card) => card.id === dependent.body.card.id)?.blockedBy).toEqual([
      blocker.body.card.id,
    ]);

    expect((await server.request(`/api/cards/${blocker.body.card.id}`, { method: "DELETE" })).response.status).toBe(200);
    expect((await board(server)).cards.find((card) => card.id === dependent.body.card.id)?.blockedBy).toEqual([]);
    expect(
      (await server.request(`/api/cards/${blocker.body.card.id}/restore`, {
        method: "POST",
        body: JSON.stringify({}),
      })).response.status,
    ).toBe(200);
    expect((await board(server)).cards.find((card) => card.id === dependent.body.card.id)?.blockedBy).toEqual([
      blocker.body.card.id,
    ]);
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

  it("migrates legacy SQLite cards into Markdown exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-board-migration-"));
    directories.push(directory);
    const first = await startTestServer(directory);
    await bootstrap(first);
    const workspace = await board(first);
    await first.close();

    const database = new DatabaseSync(first.databasePath);
    const timestamp = "2026-08-03T12:00:00.000Z";
    database
      .prepare(
        `INSERT INTO cards (
          id, project_id, title, description, status, position, assignee_id, created_by, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        "9c46098a-7e85-48de-8a58-213236a8cf0d",
        workspace.project.id,
        "Legacy spell card",
        "Preserve this body.",
        "ready",
        0,
        workspace.currentUser.id,
        workspace.currentUser.id,
        timestamp,
        timestamp,
      );
    database.close();

    const second = await startTestServer(directory);
    await second.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect((await board(second)).cards).toEqual([
      expect.objectContaining({ title: "Legacy spell card", description: "Preserve this body." }),
    ]);

    const migrated = readFileSync(
      join(second.cardsDirectory, "wizard-simulator", "cards", "9c46098a-7e85-48de-8a58-213236a8cf0d.md"),
      "utf8",
    );
    expect(migrated).toContain("title: Legacy spell card");
    const migratedDatabase = new DatabaseSync(second.databasePath);
    expect(migratedDatabase.prepare("SELECT COUNT(*) AS count FROM cards").get()).toEqual({ count: 0 });
    migratedDatabase.close();
  });
});
