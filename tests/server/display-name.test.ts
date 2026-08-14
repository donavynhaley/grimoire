import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page, IdeaWorkspace, User } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

describe("display name", () => {
  it("renames the current user everywhere the name is shown", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const created = await server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Sketch the shop counter" }),
    });
    expect(created.response.status).toBe(201);

    await server.request("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ title: "A cauldron that remembers" }),
    });

    const renamed = await server.request<{ user: User }>("/api/account/name", {
      method: "POST",
      body: JSON.stringify({ name: "Dono" }),
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.user.name).toBe("Dono");

    // The name is joined in at read time, so existing work must carry it without a rewrite.
    const board = (await server.request<BoardWorkspace>("/api/board")).body;
    expect(board.currentUser.name).toBe("Dono");
    expect(board.members.map((member) => member.name)).toEqual(["Dono"]);
    expect(board.pages[0].createdByName).toBe("Dono");

    const ideas = (await server.request<IdeaWorkspace>("/api/ideas")).body;
    expect(ideas.ideas[0].createdByName).toBe("Dono");
  });

  it("trims the name and rejects one that is too short", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const padded = await server.request<{ user: User }>("/api/account/name", {
      method: "POST",
      body: JSON.stringify({ name: "  Dono  " }),
    });
    expect(padded.body.user.name).toBe("Dono");

    const tooShort = await server.request("/api/account/name", {
      method: "POST",
      body: JSON.stringify({ name: "D" }),
    });
    expect(tooShort.response.status).toBe(400);
    expect((await server.request<BoardWorkspace>("/api/board")).body.currentUser.name).toBe("Dono");
  });

  it("refuses to rename a signed-out visitor", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await server.request("/api/auth/logout", { method: "POST" });

    const attempt = await server.request("/api/account/name", {
      method: "POST",
      body: JSON.stringify({ name: "Somebody Else" }),
    });
    expect(attempt.response.status).toBe(401);
  });
});
