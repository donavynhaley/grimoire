import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as media from "../../server/attachment-media";
import {
  ATTACHMENT_CHUNK_LIMIT,
  type AttachmentMediaType,
  type AttachmentUpload,
  type PageAttachment,
} from "../../shared/attachments";
import type { BoardWorkspace, Page } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/attachments/${name}`, import.meta.url));
const PNG = fixture("image.png");
const VIDEO = fixture("recording.mp4");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(directory?: string) {
  const server = await startTestServer(directory);
  await bootstrap(server);
  const { body: board } = await server.request<BoardWorkspace>("/api/board");
  const {
    body: { page },
  } = await server.request<{ page: Page }>("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title: "Recording evidence", description: "Keep this brief." }),
  });
  const { body: token } = await server.request<{ secret: string; token: { id: string } }>(
    "/api/agent-tokens",
    { method: "POST", body: JSON.stringify({ name: "Evidence agent", scope: "write" }) },
  );
  const raw = (
    path: string,
    body?: unknown,
    secret = token.secret,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${server.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (path: string, body?: unknown): Promise<AttachmentUpload> => {
    const response = await raw(path, body);
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBeLessThan(300);
    return result as AttachmentUpload;
  };
  const input = (bytes = PNG, mediaType: AttachmentMediaType = "image/png", key = sha(bytes)) => ({
    filename: mediaType === "video/mp4" ? "screen recording.mp4" : "evidence.png",
    mediaType,
    size: bytes.length,
    sha256: sha(bytes),
    key,
  });
  const begin = (bytes = PNG, mediaType: AttachmentMediaType = "image/png", key = sha(bytes)) =>
    call(`/api/pages/${page.id}/attachments/uploads`, input(bytes, mediaType, key));
  const chunk = (id: string, bytes: Buffer, offset = 0) =>
    call(`/api/attachment-uploads/${id}/chunks`, { offset, data: bytes.toString("base64") });
  const complete = (id: string) => call(`/api/attachment-uploads/${id}/complete`, {});
  const attach = async (bytes = PNG, mediaType: AttachmentMediaType = "image/png") => {
    const upload = await begin(bytes, mediaType);
    await chunk(upload.id, bytes);
    return complete(upload.id);
  };
  return { server, board, page, token, raw, call, input, begin, chunk, complete, attach };
}

describe("page attachments", () => {
  it("attaches remote agent bytes without losing notes, concurrent edits, or duplicating retries", async () => {
    const ctx = await setup();
    const upload = await ctx.begin();
    expect(upload).toMatchObject({ state: "uploading", offset: 0, pageId: ctx.page.id });
    await ctx.chunk(upload.id, PNG.subarray(0, 40));
    expect((await ctx.begin()).offset).toBe(40);
    await ctx.server.request(`/api/pages/${ctx.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        description: "A person edited the brief while uploading.",
        expectedDescription: "Keep this brief.",
      }),
    });
    // Retry a chunk whose first 40 bytes were received before the connection was lost.
    await ctx.chunk(upload.id, PNG);
    await ctx.chunk(upload.id, PNG);
    const result = await ctx.complete(upload.id);
    expect(result.attachment).toMatchObject({
      id: upload.id,
      pageId: ctx.page.id,
      filename: "evidence.png",
      mediaType: "image/png",
      sha256: sha(PNG),
      reference: `/api/attachments/${upload.id}?project=${ctx.board.project.id}`,
      embed: `![evidence.png](/api/attachments/${upload.id}?project=${ctx.board.project.id} "image/png")`,
    });
    expect(await ctx.complete(upload.id)).toEqual(result);
    expect(await ctx.begin()).toEqual(result);
    const listed = (await (await ctx.raw(`/api/pages/${ctx.page.id}/attachments`)).json()) as {
      attachments: PageAttachment[];
    };
    expect(listed.attachments).toHaveLength(1);
    const page = await ctx.server.request<{ page: Page }>(`/api/pages/${ctx.page.id}`);
    expect(page.body.page.description).toBe("A person edited the brief while uploading.");
    const image = await ctx.server.fetchRaw(result.attachment!.reference);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    const history = await ctx.server.request<{ events: Array<{ changes: Array<{ field: string }> }> }>(
      `/api/activity?entity=${ctx.page.id}`,
    );
    expect(
      history.body.events.filter((event) => event.changes.some((change) => change.field === "attachment")),
    ).toHaveLength(1);
  });

  it("deletes bytes only after the last embed is successfully saved away", async () => {
    const ctx = await setup();
    const { attachment } = await ctx.attach();
    const embed = attachment!.embed!;
    const patch = (description: string, expectedDescription?: string) =>
      ctx.server.request(`/api/pages/${ctx.page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ description, expectedDescription }),
      });
    await patch(`${embed}\n\n${embed}`);
    await patch(embed);
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(200);
    const conflict = await patch("", "stale draft");
    expect(conflict.response.status).toBe(409);
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(200);
    await patch("Keep the surrounding notes.", embed);
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(404);
    const slug = readdirSync(ctx.server.pagesDirectory)[0]!;
    expect(existsSync(join(ctx.server.pagesDirectory, slug, "attachments", attachment!.id))).toBe(false);
    expect(
      (await ctx.server.request<{ attachments: PageAttachment[] }>(`/api/pages/${ctx.page.id}/attachments`))
        .body.attachments,
    ).toEqual([]);
    // Re-selecting deleted media starts a new upload even with the original retry key.
    expect((await ctx.begin()).state).toBe("uploading");
  });

  it("keeps media referenced by another page, including an archived page", async () => {
    const ctx = await setup();
    const { attachment } = await ctx.attach();
    const embed = attachment!.embed!;
    const other = await ctx.server.request<{ page: Page }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title: "Shared evidence", description: embed }),
    });
    await ctx.server.request(`/api/pages/${ctx.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: embed }),
    });
    await ctx.server.request(`/api/pages/${other.body.page.id}`, { method: "DELETE" });
    await ctx.server.request(`/api/pages/${ctx.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "" }),
    });
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(200);
    await ctx.server.request(`/api/pages/${other.body.page.id}/restore`, { method: "POST", body: "{}" });
    await ctx.server.request(`/api/pages/${other.body.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "" }),
    });
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(404);
  });

  it("retains evidence cited in discussion when its notes embed is removed", async () => {
    const ctx = await setup();
    const { attachment } = await ctx.attach();
    await ctx.server.request(`/api/pages/${ctx.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: attachment!.embed }),
    });
    const discussion = await ctx.server.request(`/api/pages/${ctx.page.id}/discussion`, {
      method: "POST",
      body: JSON.stringify({ body: `See ${attachment!.reference}` }),
    });
    expect(discussion.response.status).toBeLessThan(300);
    await ctx.server.request(`/api/pages/${ctx.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "" }),
    });
    expect((await ctx.server.fetchRaw(attachment!.reference)).status).toBe(200);
  });

  it.each([false, true])(
    "moves legacy evidence into notes once, including archived pages (%s)",
    async (archived) => {
      const directory = mkdtempSync(join(tmpdir(), "grimoire-notes-migration-"));
      directories.push(directory);
      const ctx = await setup(directory);
      const image = (await ctx.attach()).attachment!;
      const video = (await ctx.attach(VIDEO, "video/mp4")).attachment!;
      await ctx.server.request(`/api/pages/${ctx.page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ description: image.embed }),
      });
      const slug = readdirSync(ctx.server.pagesDirectory)[0]!;
      for (const file of [image, video]) {
        rmSync(join(ctx.server.pagesDirectory, slug, "attachments", file.id, "notes-inline"));
      }
      if (archived) await ctx.server.request(`/api/pages/${ctx.page.id}`, { method: "DELETE" });
      await ctx.server.close();
      const reopened = await startTestServer(directory);
      const record = readFileSync(
        join(reopened.pagesDirectory, slug, archived ? "archive" : "pages", `${ctx.page.id}.md`),
        "utf8",
      );
      expect(record.split(image.reference)).toHaveLength(2);
      expect(record.split(video.reference)).toHaveLength(2);
      await reopened.close();
      const again = await startTestServer(directory);
      expect(
        readFileSync(
          join(again.pagesDirectory, slug, archived ? "archive" : "pages", `${ctx.page.id}.md`),
          "utf8",
        ),
      ).toBe(record);
    },
  );

  it.each([
    ["image.jpg", "image/jpeg"],
    ["image.webp", "image/webp"],
    ["image.gif", "image/gif"],
  ] as const)("validates and renders the existing %s format", async (name, type) => {
    const ctx = await setup();
    const result = await ctx.attach(fixture(name), type);
    const response = await ctx.server.fetchRaw(result.attachment!.reference);
    expect(response.headers.get("content-type")).toBe(type);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture(name));
  });

  it("serves MP4 byte ranges, seeking, HEAD, and named downloads", async () => {
    const ctx = await setup();
    const result = await ctx.attach(VIDEO, "video/mp4");
    const reference = result.attachment!.reference;
    for (const [range, start, end] of [
      ["bytes=0-99", 0, 99],
      ["bytes=100-", 100, VIDEO.length - 1],
      ["bytes=-20", VIDEO.length - 20, VIDEO.length - 1],
    ] as const) {
      const response = await ctx.server.fetchRaw(reference, { headers: { range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${VIDEO.length}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO.subarray(start, end + 1));
    }
    for (const range of [
      "bytes=999999999-",
      "bytes=4-2",
      "bytes=-0",
      "bytes=0-1,4-5",
      "bytes=-",
      "bytes=nope",
    ]) {
      const response = await ctx.server.fetchRaw(reference, { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${VIDEO.length}`);
    }
    const head = await ctx.server.fetchRaw(reference, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(VIDEO.length));
    expect(await head.text()).toBe("");
    const download = await ctx.server.fetchRaw(`${reference}&download=1`);
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain("screen%20recording.mp4");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(VIDEO);
  });

  it("denies anonymous and read-only uploads while permitting authorized reads", async () => {
    const ctx = await setup();
    const { body: read } = await ctx.server.request<{ secret: string }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Reader", scope: "read" }),
    });
    const upload = await ctx.begin();
    const paths = [
      `/api/pages/${ctx.page.id}/attachments/uploads`,
      `/api/attachment-uploads/${upload.id}/chunks`,
      `/api/attachment-uploads/${upload.id}/complete`,
      `/api/attachment-uploads/${upload.id}/cancel`,
    ];
    for (const path of paths) {
      expect((await ctx.raw(path, {}, read.secret)).status).toBe(403);
      expect((await fetch(`${ctx.server.baseUrl}${path}`, { method: "POST", body: "{}" })).status).toBe(401);
    }
    const result = await ctx.attach();
    expect((await ctx.raw(`/api/pages/${ctx.page.id}/attachments`, undefined, read.secret)).status).toBe(200);
    expect((await ctx.raw(result.attachment!.reference, undefined, read.secret)).status).toBe(200);
    expect((await fetch(`${ctx.server.baseUrl}${result.attachment!.reference}`)).status).toBe(401);
    // Old account/image surfaces stay outside the delegated credential's allowlist.
    expect((await ctx.raw("/api/images", {})).status).toBe(403);
  });

  it("isolates project tokens, upload ownership, pages, and private media", async () => {
    const ctx = await setup();
    const result = await ctx.attach();
    const { body: other } = await ctx.server.request<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Other board" }),
    });
    const headers = { "x-grimoire-project": other.project.id };
    const { body: otherToken } = await ctx.server.request<{ secret: string }>("/api/agent-tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Other board agent", scope: "write" }),
    });
    for (const path of [
      `/api/pages/${ctx.page.id}/attachments`,
      result.attachment!.reference,
      `/api/attachment-uploads/${result.id}`,
    ])
      expect((await ctx.raw(path, undefined, ctx.token.secret, headers)).status).toBe(403);
    expect(
      (await ctx.raw(`/api/pages/${ctx.page.id}/attachments/uploads`, ctx.input(), otherToken.secret)).status,
    ).toBe(404);
    expect((await ctx.raw(`/api/attachments/${result.id}`, undefined, otherToken.secret)).status).toBe(404);
    expect((await ctx.raw(`/api/attachment-uploads/${result.id}`, undefined, otherToken.secret)).status).toBe(
      404,
    );
    expect((await ctx.raw(result.attachment!.reference, undefined, otherToken.secret)).status).toBe(403);
    expect(
      (await ctx.server.fetchRaw(`/api/attachments/${result.id}?project=${other.project.id}`)).status,
    ).toBe(404);
    const invite = await ctx.server.request<{ code: string }>("/api/invites", { method: "POST", body: "{}" });
    expect(invite.response.status, JSON.stringify(invite.body)).toBe(201);
    const registered = await ctx.server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Teammate",
        email: "teammate@example.com",
        password: "another secure password",
        inviteCode: invite.body.code,
      }),
    });
    expect(registered.response.status, JSON.stringify(registered.body)).toBe(201);
    expect((await ctx.server.request(`/api/attachment-uploads/${result.id}`)).response.status).toBe(403);
    expect((await ctx.server.fetchRaw(result.attachment!.reference)).status).toBe(200);
  });

  it("refuses corrupt media, mismatched declarations, unsupported files, and invalid checksums without publishing", async () => {
    const ctx = await setup();
    for (const [bytes, type, status] of [
      [Buffer.from("<svg>not allowed</svg>"), "image/png", 415],
      [PNG.subarray(0, 32), "image/png", 415],
      [PNG, "video/mp4", 415],
      [VIDEO.subarray(0, 200), "video/mp4", 415],
    ] as const) {
      const upload = await ctx.begin(bytes, type);
      await ctx.chunk(upload.id, bytes);
      const response = await ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {});
      expect(response.status, JSON.stringify(await response.json())).toBe(status);
      expect((await ctx.raw(`/api/attachments/${upload.id}`)).status).toBe(404);
      await ctx.call(`/api/attachment-uploads/${upload.id}/cancel`, {});
    }
    const upload = await ctx.begin();
    await ctx.chunk(upload.id, Buffer.alloc(PNG.length));
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {})).status).toBe(422);
    const list = await (await ctx.raw(`/api/pages/${ctx.page.id}/attachments`)).json();
    expect(list).toEqual({ attachments: [] });
  });

  it("enforces limits, filenames, retry conflicts, and exact chunk bytes", async () => {
    const ctx = await setup();
    const route = `/api/pages/${ctx.page.id}/attachments/uploads`;
    for (const extra of [
      { size: 100_000_001, mediaType: "video/mp4" },
      { size: 0 },
      { filename: "../outside.png" },
      { filename: "bad\ud800.png" },
      { filename: "bad\r\nheader.png" },
      { mediaType: "image/svg+xml" },
      { localPath: "/etc/passwd" },
    ])
      expect((await ctx.raw(route, { ...ctx.input(), ...extra })).status).toBe(400);
    expect((await ctx.raw(route, { ...ctx.input(), size: 10_000_001 })).status).toBe(413);
    const upload = await ctx.begin();
    expect((await ctx.raw(route, { ...ctx.input(), filename: "different.png" })).status).toBe(409);
    const chunks = `/api/attachment-uploads/${upload.id}/chunks`;
    expect((await ctx.raw(chunks, { offset: 0, data: "!!invalid!!" })).status).toBe(400);
    expect(
      (
        await ctx.raw(chunks, {
          offset: 0,
          data: Buffer.alloc(ATTACHMENT_CHUNK_LIMIT + 1).toString("base64"),
        })
      ).status,
    ).toBe(413);
    expect((await ctx.raw(chunks, { offset: 10, data: PNG.toString("base64") })).status).toBe(409);
    await ctx.chunk(upload.id, PNG.subarray(0, 40));
    expect((await ctx.raw(chunks, { offset: 0, data: Buffer.alloc(40).toString("base64") })).status).toBe(
      409,
    );
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {})).status).toBe(409);
  });

  it("resumes after restart and cleans expired or cancelled staging without deleting committed evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-attachments-restart-"));
    directories.push(directory);
    const ctx = await setup(directory);
    const upload = await ctx.begin();
    await ctx.chunk(upload.id, PNG.subarray(0, 40));
    const committed = await ctx.attach(VIDEO, "video/mp4");
    await ctx.server.close();
    const reopened = await startTestServer(directory);
    const raw = (path: string, body?: unknown) =>
      fetch(`${reopened.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${ctx.token.secret}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect(await (await raw(`/api/attachment-uploads/${upload.id}`)).json()).toMatchObject({
      offset: 40,
      state: "uploading",
    });
    const pending = join(reopened.pagesDirectory, "getting-started", "attachments", ".uploads", upload.id);
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(pending, expired, expired);
    expect((await raw(`/api/pages/${ctx.page.id}/attachments/uploads`, ctx.input())).status).toBe(201);
    expect(await (await raw(`/api/attachment-uploads/${upload.id}`)).json()).toMatchObject({ offset: 0 });
    expect((await raw(`/api/attachment-uploads/${upload.id}/cancel`, {})).status).toBe(200);
    expect((await raw(`/api/attachment-uploads/${upload.id}/cancel`, {})).status).toBe(200);
    expect(readdirSync(join(pending, ".."))).toHaveLength(0);
    expect((await raw(`/api/attachment-uploads/${committed.id}/cancel`, {})).status).toBe(409);
    expect((await raw(committed.attachment!.reference)).status).toBe(200);
  });

  it("uploads a local multi-chunk recording with the companion CLI and resumes without duplicates", async () => {
    const ctx = await setup();
    const directory = mkdtempSync(join(tmpdir(), "grimoire-uploader-"));
    directories.push(directory);
    // An inert ISO BMFF free box makes a real playable recording span several chunks.
    const padding = Buffer.alloc(1_100_000);
    padding.writeUInt32BE(padding.length, 0);
    padding.write("free", 4, "ascii");
    const bytes = Buffer.concat([VIDEO, padding]);
    const path = join(directory, "large recording.mp4");
    writeFileSync(path, bytes);
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "packages/grimoire-mcp/src/upload.ts", ctx.page.id, path],
        {
          env: { ...process.env, GRIMOIRE_URL: ctx.server.baseUrl, GRIMOIRE_TOKEN: ctx.token.secret },
          timeout: 20_000,
        },
      );
    const first = JSON.parse((await run()).stdout) as PageAttachment;
    expect(first).toMatchObject({
      pageId: ctx.page.id,
      filename: "large recording.mp4",
      size: bytes.length,
      sha256: sha(bytes),
    });
    expect(JSON.parse((await run()).stdout)).toEqual(first);
    const response = await ctx.raw(first.reference.replace(ctx.server.baseUrl, ""));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }, 20_000);

  it("bounds abandoned staging and restarts an initialization interrupted before content was created", async () => {
    const ctx = await setup();
    const upload = await ctx.begin();
    const path = join(ctx.server.pagesDirectory, "getting-started", "attachments", ".uploads", upload.id);
    rmSync(join(path, "content"));
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}`)).status).toBe(410);
    expect((await ctx.begin()).offset).toBe(0);
    for (let index = 0; index < 7; index++) await ctx.begin(PNG, "image/png", `pending-${index}`);
    expect(
      (
        await ctx.raw(
          `/api/pages/${ctx.page.id}/attachments/uploads`,
          ctx.input(PNG, "image/png", "pending-overflow"),
        )
      ).status,
    ).toBe(429);
    await ctx.call(`/api/attachment-uploads/${upload.id}/cancel`, {});
    expect((await ctx.begin(PNG, "image/png", "pending-replacement")).offset).toBe(0);
  });

  it("rechecks a revoked credential after asynchronous validation and rejects overlapping mutations", async () => {
    const ctx = await setup();
    const upload = await ctx.begin();
    await ctx.chunk(upload.id, PNG);
    let started!: () => void;
    let release!: () => void;
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(media, "validateAttachmentMedia").mockImplementation(async () => {
      started();
      await finished;
    });
    const completion = ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {});
    await beginning;
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}/cancel`, {})).status).toBe(409);
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {})).status).toBe(409);
    expect(
      (
        await ctx.raw(`/api/attachment-uploads/${upload.id}/chunks`, {
          offset: 0,
          data: PNG.toString("base64"),
        })
      ).status,
    ).toBe(409);
    await ctx.server.request(`/api/agent-tokens/${ctx.token.token.id}`, { method: "DELETE" });
    release();
    expect((await completion).status).toBe(403);
    expect((await ctx.server.request(`/api/pages/${ctx.page.id}/attachments`)).body).toEqual({
      attachments: [],
    });
  });

  it("keeps partial files private and refuses completion after a page is archived or a token revoked", async () => {
    const ctx = await setup();
    const upload = await ctx.begin();
    await ctx.chunk(upload.id, PNG);
    expect((await ctx.raw(`/api/attachments/${upload.id}`)).status).toBe(404);
    await ctx.server.request(`/api/pages/${ctx.page.id}`, { method: "DELETE" });
    expect((await ctx.raw(`/api/attachment-uploads/${upload.id}/complete`, {})).status).toBe(404);
    await ctx.server.request(`/api/agent-tokens/${ctx.token.token.id}`, { method: "DELETE" });
    expect(
      (
        await ctx.raw(`/api/attachment-uploads/${upload.id}/chunks`, {
          offset: 0,
          data: PNG.toString("base64"),
        })
      ).status,
    ).toBe(401);
  });
});
