import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditPage, BoardWorkspace, ImportResponse } from "../../shared/types";
import { provisionImportTarget } from "../fixtures/importers";
import { ownerAccount, startTestServer } from "./test-server";

type Server = Awaited<ReturnType<typeof startTestServer>>;

const realArchive = Uint8Array.from(
  readFileSync(join(__dirname, "..", "fixtures", "project-tasks.boardarchive")),
).buffer;

/**
 * A small board shaped like Trello's export: one list the synonym table knows, one it has
 * no name for, so the route has to hand back the mapping question before anything applies.
 */
const trelloExport = JSON.stringify({
  name: "Side Project",
  lists: [
    { id: "list-todo", name: "To Do", closed: false, pos: 1 },
    { id: "list-weird", name: "Weird Pile", closed: false, pos: 2 },
  ],
  cards: [
    {
      id: "66a1b2c30000000000000001",
      name: "Ship the settings import",
      desc: "Upload, map, apply.",
      idList: "list-todo",
      closed: false,
      pos: 1,
      labels: [{ id: "lb1", name: "Story" }],
    },
    {
      id: "66a1b2c40000000000000002",
      name: "Waiting on the mockups",
      desc: "",
      idList: "list-weird",
      closed: false,
      pos: 1,
    },
  ],
});

async function postImport(
  server: Server,
  projectId: string,
  query: string,
  body: ArrayBuffer | string,
): Promise<{ status: number; body: ImportResponse }> {
  const response = await server.fetchRaw(`/api/import?${query}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/octet-stream", "x-grimoire-project": projectId },
  });
  return { status: response.status, body: (await response.json()) as ImportResponse };
}

async function boardPages(server: Server, projectId: string) {
  const { body } = await server.request<BoardWorkspace>("/api/board", {
    headers: { "x-grimoire-project": projectId },
  });
  return body.pages.filter((page) => page.title !== "Predates the import");
}

describe("POST /api/import", () => {
  it("plans without writing, handing back the unmapped lists as data for the mapping screen", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server, ["Story"]);

    const { status, body } = await postImport(server, projectId, "source=trello", trelloExport);

    expect(status).toBe(200);
    expect(body.applied).toBeNull();
    expect(body.plan.unmappedLists).toEqual([{ name: "Weird Pile", cards: 1 }]);
    expect(body.plan.toCreate).toEqual([{ title: "Ship the settings import", status: "ready" }]);
    expect(await boardPages(server, projectId)).toHaveLength(0);
  });

  it("refuses to apply while a list is unmapped, and writes nothing", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server, ["Story"]);

    const { status } = await postImport(server, projectId, "source=trello&apply=1", trelloExport);

    expect(status).toBe(422);
    expect(await boardPages(server, projectId)).toHaveLength(0);
  });

  it("applies a fully mapped import: pages land, positions append, the log says it happened once", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server, ["Story"]);
    const query = `source=trello&apply=1&list=${encodeURIComponent("Weird Pile=Review")}`;

    const { status, body } = await postImport(server, projectId, query, trelloExport);
    expect(status).toBe(200);
    expect(body.applied).toBe(2);

    const pages = await boardPages(server, projectId);
    expect(pages).toHaveLength(2);
    const shipped = pages.find((page) => page.title === "Ship the settings import")!;
    expect(shipped.status).toBe("ready");
    expect(shipped.category).toBe("story");
    expect(shipped.description).toContain("Imported from Trello card 66a1b2c30000000000000001");
    expect(pages.find((page) => page.title === "Waiting on the mockups")!.status).toBe("review");

    // One project event, not one per page - an import must not bury the log.
    const activity = await server.request<AuditPage>("/api/activity", {
      headers: { "x-grimoire-project": projectId },
    });
    const imports = activity.body.events.filter((event) =>
      event.changes.some((change) => change.field === "import"),
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]!.changes[0]!.to).toBe("2 pages from Trello");
  });

  it("skips already-imported cards on a second apply instead of duplicating them", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server, ["Story"]);
    const query = `source=trello&apply=1&list=${encodeURIComponent("Weird Pile=Review")}`;

    await postImport(server, projectId, query, trelloExport);
    const rerun = await postImport(server, projectId, query, trelloExport);

    expect(rerun.status).toBe(200);
    expect(rerun.body.applied).toBe(0);
    expect(await boardPages(server, projectId)).toHaveLength(2);
  });

  it("imports the archive the real Focalboard exported, once its real statuses are mapped", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server);

    const planned = await postImport(server, projectId, "source=focalboard", realArchive);
    expect(planned.status).toBe(200);
    expect(planned.body.plan.unmappedOptions.map((option) => option.value).sort()).toEqual([
      "Archived",
      "Blocked",
    ]);

    const query = `source=focalboard&apply=1&option=${encodeURIComponent("Blocked=Review")}&option=${encodeURIComponent("Archived=Done")}`;
    const applied = await postImport(server, projectId, query, realArchive);
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(6);

    const pages = await boardPages(server, projectId);
    expect(pages.find((page) => page.title === "Requirements sign-off")!.status).toBe("review");
    expect(pages.find((page) => page.title === "Validate the Grimoire importer")!.status).toBe("backlog");
  });

  it("is the owner's alone: a member is refused and nothing is written", async () => {
    const server = await startTestServer();
    const projectId = await provisionImportTarget(server, ["Story"]);
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: "{}",
      headers: { "x-grimoire-project": projectId },
    });
    await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Maren Voss",
        email: "maren@example.com",
        password: "a perfectly fine password",
        inviteCode: invite.body.code,
      }),
    });

    const refused = await postImport(server, projectId, "source=trello&apply=1", trelloExport);
    expect(refused.status).toBe(403);

    await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(await boardPages(server, projectId)).toHaveLength(0);
  });
});
