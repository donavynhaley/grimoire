import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace persistence", () => {
  it("creates a seeded Wizard Simulator workspace for the owner", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const workspace = await server.request<{
      project: { name: string; currentDirection: string };
      members: Array<{ name: string }>;
      milestones: Array<{ title: string; conditions: unknown[] }>;
    }>("/api/workspace");

    expect(workspace.response.status).toBe(200);
    expect(workspace.body.project.name).toBe("Wizard Simulator");
    expect(workspace.body.project.currentDirection).toContain("Wizard Sight");
    expect(workspace.body.members).toEqual([expect.objectContaining({ name: "Donavyn" })]);
    expect(workspace.body.milestones[0]).toMatchObject({ title: "Wizard Sight vertical slice" });
    expect(workspace.body.milestones[0].conditions.length).toBeGreaterThan(0);
  });

  it("persists captured ideas after the server restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-persistence-"));
    directories.push(directory);
    const first = await startTestServer(directory);
    await bootstrap(first);

    const created = await first.request<{ idea: { id: string; title: string } }>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "Let the tower door remember Maren" }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.idea.title).toBe("Let the tower door remember Maren");
    await first.close();

    const second = await startTestServer(directory);
    const login = await second.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(login.response.status).toBe(200);

    const workspace = await second.request<{ ideas: Array<{ title: string }> }>("/api/workspace");
    expect(workspace.body.ideas.map((idea) => idea.title)).toContain(
      "Let the tower door remember Maren",
    );
  });
});

