import { describe, expect, it } from "vitest";
import type { BoardWorkspace } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("profile pictures", () => {
  it("uploads, serves, and removes the current user's picture", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const uploaded = await server.request<{ avatarUrl: string }>("/api/account/avatar", {
      method: "PUT",
      body: ONE_PIXEL_PNG,
      headers: { "content-type": "image/png" },
    });
    expect(uploaded.response.status).toBe(200);
    expect(uploaded.body.avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f-]{36}\?v=\d+$/);

    const board = (await server.request<BoardWorkspace>("/api/board")).body;
    expect(board.currentUser.avatarUrl).toBe(uploaded.body.avatarUrl);
    expect(board.members[0].avatarUrl).toBe(uploaded.body.avatarUrl);

    const image = await server.fetchRaw(uploaded.body.avatarUrl);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);

    const removed = await server.request("/api/account/avatar", { method: "DELETE" });
    expect(removed.response.status).toBe(200);
    expect((await server.request<BoardWorkspace>("/api/board")).body.currentUser.avatarUrl).toBeNull();
    expect((await server.fetchRaw(`/api/avatars/${board.currentUser.id}`)).status).toBe(404);
  });

  it("rejects files that are not real images", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const rejected = await server.request<{ error: string }>("/api/account/avatar", {
      method: "PUT",
      body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      headers: { "content-type": "image/svg+xml" },
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain("PNG, JPEG, or WebP");
  });

  it("requires authentication to view pictures", async () => {
    const server = await startTestServer();
    const anonymous = await fetch(`${server.baseUrl}/api/avatars/00000000-0000-4000-8000-000000000010`);
    expect(anonymous.status).toBe(401);
  });
});
