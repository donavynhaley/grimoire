import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap, startTestServer } from "./test-server";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ONE_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

describe("project images", () => {
  it("uploads a pasted image and serves it back for the project", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const uploaded = await server.request<{ name: string }>("/api/images", {
      method: "POST",
      body: ONE_PIXEL_PNG,
      headers: { "content-type": "image/png" },
    });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.name).toMatch(/^pasted-image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/);

    const imagesDirectory = join(server.pagesDirectory, "getting-started", "images");
    expect(readdirSync(imagesDirectory)).toEqual([uploaded.body.name]);

    const served = await server.fetchRaw(`/api/images/${encodeURIComponent(uploaded.body.name)}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
  });

  it("accepts animated GIF reference material", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const uploaded = await server.request<{ name: string }>("/api/images", {
      method: "POST",
      body: ONE_PIXEL_GIF,
      headers: { "content-type": "image/gif" },
    });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.name).toMatch(/\.gif$/);

    const served = await server.fetchRaw(`/api/images/${encodeURIComponent(uploaded.body.name)}`);
    expect(served.headers.get("content-type")).toBe("image/gif");
  });

  it("serves externally added files with the names Obsidian generates", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const uploaded = await server.request<{ name: string }>("/api/images", {
      method: "POST",
      body: ONE_PIXEL_PNG,
      headers: { "content-type": "image/png" },
    });
    const { renameSync } = await import("node:fs");
    const imagesDirectory = join(server.pagesDirectory, "getting-started", "images");
    renameSync(
      join(imagesDirectory, uploaded.body.name),
      join(imagesDirectory, "Pasted image 20260807183045.png"),
    );

    const served = await server.fetchRaw(
      `/api/images/${encodeURIComponent("Pasted image 20260807183045.png")}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("rejects uploads that are not real images", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const rejected = await server.request<{ error: string }>("/api/images", {
      method: "POST",
      body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      headers: { "content-type": "image/svg+xml" },
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain("PNG, JPEG, WebP, or GIF");

    const imagesDirectory = join(server.pagesDirectory, "getting-started", "images");
    expect(existsSync(imagesDirectory)).toBe(false);
  });

  it("refuses names that reach outside the images directory", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    for (const name of ["..%2F..%2Fgrimoire.sqlite", ".hidden.png", "notes.md", "%zz"]) {
      const response = await server.fetchRaw(`/api/images/${name}`);
      expect(response.status, name).toBe(404);
    }
  });

  it("requires authentication for uploads and reads", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const uploaded = await server.request<{ name: string }>("/api/images", {
      method: "POST",
      body: ONE_PIXEL_PNG,
      headers: { "content-type": "image/png" },
    });

    const anonymousRead = await fetch(`${server.baseUrl}/api/images/${uploaded.body.name}`);
    expect(anonymousRead.status).toBe(401);
    const anonymousUpload = await fetch(`${server.baseUrl}/api/images`, {
      method: "POST",
      body: ONE_PIXEL_PNG,
    });
    expect(anonymousUpload.status).toBe(401);
  });
});
