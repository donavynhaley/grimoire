import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  editConflict,
  request,
  setActiveProjectId,
  uploadPageAttachment,
} from "../../src/api/client";

/**
 * The client is the one door every interface request goes through, so its error
 * handling is what every dialog's error handling actually is. These tests speak to
 * a stubbed fetch directly - the rest of the UI suite stubs underneath the client
 * and never exercises it.
 */

function respond(body: string, init: ResponseInit = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, init)),
  );
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the request to be refused");
}

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveProjectId(null);
});

describe("the api client", () => {
  it("returns the parsed body of a successful response", async () => {
    respond(JSON.stringify({ ok: true }), { status: 200 });
    await expect(request<{ ok: boolean }>("/api/board")).resolves.toEqual({ ok: true });
  });

  it("turns a JSON refusal into an ApiError carrying the server's sentence", async () => {
    respond(JSON.stringify({ error: "Only the project owner can do that" }), { status: 403 });
    const failure = await failureOf(request("/api/projects"));
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(403);
    expect(failure.message).toBe("Only the project owner can do that");
  });

  it("turns a non-JSON failure into an ApiError rather than a SyntaxError", async () => {
    // A reverse proxy that cannot reach the server answers with its own HTML
    // page. That must reach the interface as the same kind of error every other
    // refusal does, or no handler catches it.
    respond("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    const failure = await failureOf(request("/api/board"));
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(502);
    expect(failure.message).toBe("Request failed with status 502");
  });

  it("survives an empty body on both success and failure", async () => {
    respond("", { status: 200 });
    await expect(request("/api/board")).resolves.toBeNull();
    respond("", { status: 500 });
    const failure = await failureOf(request("/api/board"));
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe("Request failed with status 500");
  });

  it("decodes an edit conflict, and only an edit conflict", async () => {
    respond(JSON.stringify({ conflict: true, field: "description", current: "theirs" }), { status: 409 });
    const failure = await failureOf(request("/api/pages/1"));
    expect(editConflict<string>(failure)).toEqual({
      conflict: true,
      field: "description",
      current: "theirs",
    });

    respond(JSON.stringify({ error: "They are already on this project" }), { status: 409 });
    const plain = await failureOf(request("/api/members"));
    expect(editConflict(plain)).toBeNull();
    expect(editConflict(new Error("not an api error"))).toBeNull();
  });

  it("names the active project on every request", async () => {
    respond(JSON.stringify({}), { status: 200 });
    setActiveProjectId("project-7");
    await request("/api/board");
    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("x-grimoire-project")).toBe("project-7");
  });
});

it("keeps every upload chunk in its original project when the active board changes", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const attachment = { id: "committed" };
  const headers: string[] = [];
  const chunks: Buffer[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get("x-grimoire-project")!);
      const body = JSON.parse(init.body as string);
      const base = {
        id: "pending",
        pageId: "original-page",
        state: "uploading",
        size: 4,
        chunkLimit: 2,
        attachment: null,
      };
      if (path.endsWith("/uploads")) {
        setActiveProjectId("next-project");
        return Response.json({ ...base, offset: 0 });
      }
      if (path.endsWith("/chunks")) {
        const bytes = Buffer.from(body.data, "base64");
        chunks.push(bytes);
        return Response.json({ ...base, offset: body.offset + bytes.length });
      }
      if (path.endsWith("/complete")) return Response.json({ ...base, state: "complete", attachment });
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  setActiveProjectId("original-project");
  const file = new NodeFile([new Uint8Array([1, 2, 3, 4])], "image.png", { type: "image/png" });
  await expect(
    uploadPageAttachment(
      "original-page",
      file as unknown as File,
      new AbortController().signal,
      () => undefined,
    ),
  ).resolves.toEqual(attachment);
  expect(headers).toEqual(Array(4).fill("original-project"));
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
});
