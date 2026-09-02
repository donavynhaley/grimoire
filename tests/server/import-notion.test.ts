import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MarkdownPageStore } from "../../server/markdown-pages";
import type { BoardWorkspace, Page } from "../../shared/types";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

const run = promisify(execFile);
const script = join(__dirname, "..", "..", "ops", "import-notion.mjs");

type Server = Awaited<ReturnType<typeof startTestServer>>;

/**
 * The importer replicates the server's file format rather than importing it (ops scripts stay
 * dependency-free), so this suite is what holds the two in lockstep: everything the script
 * writes must load through the real MarkdownPageStore and the real board route. Provisioning
 * mirrors the kind of workspace a map is reconciled against - a few categories, a severity and
 * an epics select, and estimates switched on - because a map's field values resolve against
 * the project's own definitions. Estimates are deliberately *not* a custom field here: they
 * are Grimoire's own, and a select named "estimate" would look the same on a page while
 * counting for nothing.
 */
async function provisionProject(server: Server): Promise<string> {
  await bootstrap(server);
  const created = await server.request<{ project: { id: string } }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Familiar Tycoon" }),
  });
  const projectId = created.body.project.id;
  const on = { headers: { "x-grimoire-project": projectId } };
  const post = (path: string, body: Record<string, unknown>) =>
    server.request(path, { method: "POST", body: JSON.stringify(body), ...on });

  await post("/api/categories", { name: "Bug", color: "#d87578" });
  await post("/api/categories", { name: "Story", color: "#8bb9c9" });
  await post("/api/categories", { name: "Research Spike", color: "#b49bd4" });
  await post("/api/fields", {
    label: "severity",
    type: "select",
    options: ["high", "medium", "low"],
    showOnTile: true,
  });
  await post("/api/fields", {
    label: "epics",
    type: "select",
    options: ["Wards", "Potions", "Shopfront", "Tutoring"],
    showOnTile: true,
  });
  await server.request(`/api/projects/${projectId}`, {
    method: "PATCH",
    // Estimates are Grimoire's own field and a separate gate from chapters. Velocity is where
    // the two meet, so a history import needs both on to mean anything.
    body: JSON.stringify({ chaptersEnabled: true, estimatesEnabled: true }),
    ...on,
  });
  await post("/api/chapters", { name: "Sprint 9: Grand Opening", state: "open" });
  await post("/api/chapters", { name: "Sprint 7: Stocking the Shelves", state: "planned" });
  // A page that predates the import, so imported positions must append rather than collide.
  await post("/api/pages", { title: "Predates the import", status: "backlog" });
  return projectId;
}

const importMap = {
  backlog_pages: [
    {
      notion_task_id: 1539,
      title: "Ward every entrance against scrying",
      category: "Story",
      column: "Backlog",
      estimate: 8,
      severity: "high",
      note: "MERGED 1539+1540+2047: zero wards on any entrance, no watch-charm",
      absorbs: [1540, 2047],
      epics: "Wards",
    },
    {
      notion_task_id: 2052,
      title: "STOCKROOM: require a key for the back door",
      category: "Bug",
      column: "Backlog",
      estimate: 2,
      severity: "medium",
      note: null,
      epics: "Wards",
    },
  ],
  as_is_pages: [
    {
      notion_task_id: 1681,
      title: "Put together a window display of enchanted wares",
      column: "Up Next",
      category: "Story",
      estimate: 3,
      severity: null,
      epics: "Shopfront",
    },
    {
      notion_task_id: 2043,
      title: "POTIONS: 'Week brew' - reconcile the ledger rows",
      column: "In progress",
      category: "Story",
      estimate: 5,
      severity: null,
      epics: "Potions",
    },
    {
      notion_task_id: 2246,
      title: "Waiting on the guild's review",
      column: "Review",
      category: "Research Spike",
      estimate: null,
      severity: null,
      epics: "Shopfront",
    },
  ],
  done_pages: [
    {
      notion_task_id: 2170,
      title: "TUTORING: Apprentice drills - measured casting time",
      category: "Story",
      column: "Done",
      chapter: "sprint-7-stocking-the-shelves",
      estimate: 5,
      severity: null,
      epics: "Tutoring",
      completed_at: "2026-07-29T03:17:49Z",
      note: null,
      body: "As a shopkeeper, I want apprentice drills to resolve quickly so that a lesson never drags.\n\nACCEPTANCE CRITERIA\n\t- GIVEN a drill in progress\n\t- WHEN a spell is cast\n\t- THEN the result settles within the measured budget",
      source: "Sprint 1-6 history, Notion export",
    },
  ],
};

function writeMap(map: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "import-map-")), "import-map.json");
  writeFileSync(path, JSON.stringify(map, null, 1));
  return path;
}

async function runImporter(server: Server, mapPath: string, extra: string[] = []) {
  return run(process.execPath, [
    script,
    mapPath,
    server.pagesDirectory,
    server.databasePath,
    "--project",
    "familiar-tycoon",
    "--as",
    ownerAccount.email,
    ...extra,
  ]);
}

function importedPages(server: Server) {
  return new MarkdownPageStore(server.pagesDirectory)
    .list("familiar-tycoon")
    .filter((page) => page.title !== "Predates the import");
}

describe("ops/import-notion.mjs", () => {
  it("dry-runs by default: validates every row and writes nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionProject(server);
    const mapPath = writeMap(importMap);
    await server.close();

    const { stdout } = await runImporter(server, mapPath);

    expect(stdout).toContain("6 to create");
    expect(stdout).toContain("Dry run - nothing written");
    expect(importedPages(server)).toEqual([]);
  });

  it("applies the map so the real store and the real board load every page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    const projectId = await provisionProject(server);
    const mapPath = writeMap(importMap);
    await server.close();

    const { stdout } = await runImporter(server, mapPath, ["--chapter", "sprint-9-grand-opening", "--apply"]);
    expect(stdout).toContain("Wrote 6 page file(s)");

    const pages = importedPages(server);
    expect(pages).toHaveLength(6);
    const byTask = new Map(
      pages.map((page) => [page.description.match(/^Imported from Notion task (\d+)/m)![1], page]),
    );

    const wards = byTask.get("1539")!;
    expect(wards.status).toBe("backlog");
    expect(wards.category).toBe("story");
    expect(wards.fields).toEqual({ severity: "high", epics: "Wards" });
    expect(wards.estimate).toBe(8);
    expect(wards.chapter).toBeNull();
    expect(wards.description).toContain("Absorbs Notion tasks 1540, 2047.");
    expect(wards.description).toContain("MERGED 1539+1540+2047");

    // Grimoire's estimate is a free number, so a 2 needs no option to exist and is not lost.
    const stockroom = byTask.get("2052")!;
    expect(stockroom.category).toBe("bug");
    expect(stockroom.fields).toEqual({ severity: "medium", epics: "Wards" });
    expect(stockroom.estimate).toBe(2);
    expect(stdout).toContain("0 with dropped values");

    // Backlog positions append after the page that predates the import.
    expect([wards.position, stockroom.position].sort()).toEqual([1, 2]);

    // The as-is slice keeps its Notion state and joins the chapter in motion.
    expect(byTask.get("1681")!.status).toBe("ready");
    expect(byTask.get("2043")!.status).toBe("in_progress");
    expect(byTask.get("2246")!.status).toBe("review");
    expect(byTask.get("2246")!.category).toBe("research-spike");
    for (const task of ["1681", "2043", "2246"]) {
      expect(byTask.get(task)!.chapter).toBe("sprint-9-grand-opening");
    }

    // Completed work is filed under the sprint that delivered it, not the sprint in motion,
    // and keeps the stated completion proxy rather than the import time.
    const shipped = byTask.get("2170")!;
    expect(shipped.status).toBe("done");
    expect(shipped.chapter).toBe("sprint-7-stocking-the-shelves");
    expect(shipped.completedAt).toBe("2026-07-29T03:17:49Z");
    expect(shipped.estimate).toBe(5);

    // A map row carrying the story keeps it, with provenance demoted to a footer. The earlier
    // history import wrote provenance and nothing else, which is the regression this guards.
    expect(shipped.description).toMatch(/^As a shopkeeper, I want apprentice drills/);
    expect(shipped.description).toContain("ACCEPTANCE CRITERIA");
    expect(shipped.description).toContain("\n---\n\nImported from Notion task 2170");
    expect(shipped.description).toContain("Sprint 1-6 history, Notion export");
    // The re-run guard still finds its marker on a line of its own.
    expect(shipped.description).toMatch(/^Imported from Notion task 2170\b/m);

    // The board itself - the strictest reader - serves what the script wrote.
    const restarted = await startTestServer(directory);
    await restarted.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    const workspace = (
      await restarted.request<BoardWorkspace>("/api/board", {
        headers: { "x-grimoire-project": projectId },
      })
    ).body;
    expect(workspace.pages).toHaveLength(7);
    const served = workspace.pages.find((page: Page) => page.title.startsWith("Ward every entrance"))!;
    expect(served.fields).toEqual({ severity: "high", epics: "Wards" });
    expect(served.estimate).toBe(8);
    await restarted.close();
  });

  it("skips already-imported tasks on a rerun instead of duplicating them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionProject(server);
    const mapPath = writeMap(importMap);
    await server.close();

    await runImporter(server, mapPath, ["--apply"]);
    const { stdout } = await runImporter(server, mapPath, ["--apply"]);

    expect(stdout).toContain("0 to create, 6 skipped");
    expect(importedPages(server)).toHaveLength(6);
  });

  it("refuses the whole import when any row fails validation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionProject(server);
    const badMap = writeMap({
      backlog_pages: [
        importMap.backlog_pages[0],
        {
          notion_task_id: 9999,
          title: "Bad severity",
          category: "Story",
          column: "Backlog",
          severity: "critical",
        },
      ],
    });
    await server.close();

    await expect(runImporter(server, badMap, ["--apply"])).rejects.toMatchObject({ code: 1 });
    expect(importedPages(server)).toEqual([]);
  });

  it("refuses a field key the project has not provisioned", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await bootstrap(server);
    const created = await server.request<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Familiar Tycoon" }),
    });
    await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Story", color: "#8bb9c9" }),
      headers: { "x-grimoire-project": created.body.project.id },
    });
    const mapPath = writeMap({
      backlog_pages: [
        {
          notion_task_id: 1,
          title: "No fields exist",
          category: "Story",
          column: "Backlog",
          epics: "Wards",
        },
      ],
    });
    await server.close();

    await expect(runImporter(server, mapPath, ["--apply"])).rejects.toMatchObject({ code: 1 });
    expect(importedPages(server)).toEqual([]);
  });

  it("reads a blank estimate as none, and refuses one that is not a whole number", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionProject(server);
    const row = { title: "Sweep the cellar", category: "Story", column: "Backlog" };
    const blank = writeMap({ backlog_pages: [{ ...row, notion_task_id: 3001, estimate: "" }] });
    const decimal = writeMap({ backlog_pages: [{ ...row, notion_task_id: 3002, estimate: 2.5 }] });
    await server.close();

    // A cell nobody filled in is not a zero, which the board would show as a real estimate.
    const { stdout } = await runImporter(server, blank, ["--apply"]);
    expect(stdout).toContain("Wrote 1 page file(s)");
    expect(importedPages(server)[0]!.estimate).toBeNull();

    // Only a whole number survives the strict frontmatter parser the server loads with, so a
    // 2.5 is refused up front rather than written as a page the board could never read back.
    await expect(runImporter(server, decimal, ["--apply"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("not a whole number"),
    });
    expect(importedPages(server)).toHaveLength(1);
  });
});
