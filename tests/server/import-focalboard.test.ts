import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page } from "../../shared/types";
import { importedPages, provisionImportTarget, runOpsImporter } from "../fixtures/importers";
import { ownerAccount, startTestServer } from "./test-server";

const script = join(__dirname, "..", "..", "ops", "import-focalboard.mjs");

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/**
 * The importer replicates the server's file format rather than importing it (ops scripts stay
 * dependency-free), so this suite is what holds the two in lockstep: everything the script
 * writes must load through the real MarkdownPageStore and the real board route. The fixture is
 * shaped like Focalboard's actual board archive - a zip of board.jsonl lines holding the board,
 * its views, its cards and their content blocks - because the whole point of this importer is
 * that a person hands it their .boardarchive untouched.
 */
const board = {
  id: "bd1",
  title: "Roadmap",
  isTemplate: false,
  cardProperties: [
    {
      id: "prop-status",
      name: "Status",
      type: "select",
      options: [
        { id: "o-ns", value: "Not Started", color: "propColorGray" },
        { id: "o-ip", value: "In Progress", color: "propColorYellow" },
        { id: "o-done", value: "Completed 🙌", color: "propColorGreen" },
        { id: "o-sm", value: "Someday Maybe", color: "propColorBlue" },
      ],
    },
    {
      id: "prop-pri",
      name: "Priority",
      type: "select",
      options: [{ id: "p-high", value: "High", color: "propColorRed" }],
    },
    { id: "prop-due", name: "Due", type: "date" },
    { id: "prop-notes", name: "Context", type: "text" },
    { id: "prop-owner", name: "Owner", type: "person" },
  ],
  createAt: 1749000000000,
  updateAt: 1755500000000,
};

const blocks = [
  {
    id: "v1",
    boardId: "bd1",
    type: "view",
    title: "Board view",
    fields: { viewType: "board", groupById: "prop-status" },
  },
  {
    id: "c-a",
    boardId: "bd1",
    type: "card",
    title: "Ship the importer",
    fields: {
      contentOrder: ["t1", ["cb1", "cb2"], "im1"],
      properties: {
        "prop-status": "o-ip",
        "prop-pri": "p-high",
        "prop-due": '{"from":1755000000000}',
        "prop-notes": "started twice already",
        "prop-owner": "u123",
      },
    },
    createAt: 1750000000000,
    updateAt: 1755500000000,
  },
  { id: "t1", boardId: "bd1", parentId: "c-a", type: "text", title: "The plan\n\nDo it **well**." },
  {
    id: "cb1",
    boardId: "bd1",
    parentId: "c-a",
    type: "checkbox",
    title: "write tests",
    fields: { value: true },
  },
  {
    id: "cb2",
    boardId: "bd1",
    parentId: "c-a",
    type: "checkbox",
    title: "write docs",
    fields: { value: false },
  },
  { id: "im1", boardId: "bd1", parentId: "c-a", type: "image", fields: { fileId: "f1.png" } },
  { id: "cm1", boardId: "bd1", parentId: "c-a", type: "comment", title: "Is this still planned?" },
  {
    id: "c-b",
    boardId: "bd1",
    type: "card",
    title: "",
    fields: { properties: { "prop-status": "o-ns" } },
    createAt: 1750000001000,
    updateAt: 1750000001000,
  },
  {
    id: "c-c",
    boardId: "bd1",
    type: "card",
    title: "Free floater",
    fields: { properties: {} },
    createAt: 1750000002000,
    updateAt: 1750000002000,
  },
  {
    id: "c-d",
    boardId: "bd1",
    type: "card",
    title: "Pick a license",
    fields: { properties: { "prop-status": "o-done" } },
    createAt: 1750000003000,
    updateAt: 1756000000000,
  },
  {
    id: "c-e",
    boardId: "bd1",
    type: "card",
    title: "Card template",
    fields: { isTemplate: true, properties: {} },
    createAt: 1750000004000,
    updateAt: 1750000004000,
  },
  {
    id: "c-f",
    boardId: "bd1",
    type: "card",
    title: "Dangling status",
    fields: { properties: { "prop-status": "o-gone" } },
    createAt: 1750000005000,
    updateAt: 1750000005000,
  },
  {
    id: "c-g",
    boardId: "bd1",
    type: "card",
    title: "Someday task",
    fields: { properties: { "prop-status": "o-sm" } },
    createAt: 1750000006000,
    updateAt: 1750000006000,
  },
];

function boardLines(boardData: unknown, blockList: unknown[]): string {
  return [
    JSON.stringify({ type: "board", data: boardData }),
    ...blockList.map((block) => JSON.stringify({ type: "block", data: block })),
  ].join("\n");
}

/**
 * A zip the way Focalboard writes one, built by hand so the suite needs no zip dependency
 * either. Sizes and offsets live in the central directory, which is the part the importer
 * reads; the CRC fields stay zero because the reader trusts the directory, not the checksum.
 */
function buildArchive(entries: Array<[name: string, content: string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = deflateRawSync(Buffer.from(content, "utf8"));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(content), 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBuffer, data);
    centralParts.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function writeArchive(entries: Array<[name: string, content: string]>): string {
  const path = join(mkdtempSync(join(tmpdir(), "focalboard-export-")), "roadmap.boardarchive");
  writeFileSync(path, buildArchive(entries));
  return path;
}

const singleBoardArchive: Array<[string, string]> = [
  ["version.json", '{"version":2,"date":1756000000000}'],
  ["bd1/board.jsonl", boardLines(board, blocks)],
];

const withSomedayMapped = ["--option", "Someday Maybe=Up Next"];

describe("ops/import-focalboard.mjs", () => {
  it("dry-runs by default: validates every card and writes nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionImportTarget(server);
    const archivePath = writeArchive(singleBoardArchive);
    await server.close();

    const { stdout } = await runOpsImporter(script, server, archivePath, withSomedayMapped);

    expect(stdout).toContain("6 to create");
    expect(stdout).toContain("Dry run - nothing written");
    expect(importedPages(server)).toEqual([]);
  });

  it("applies the archive so the real store and the real board load every card", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    const projectId = await provisionImportTarget(server);
    const archivePath = writeArchive(singleBoardArchive);
    await server.close();

    const { stdout } = await runOpsImporter(script, server, archivePath, [...withSomedayMapped, "--apply"]);
    expect(stdout).toContain("Wrote 6 page file(s)");

    const pages = importedPages(server);
    expect(pages).toHaveLength(6);
    const byCard = new Map(
      pages.map((page) => [
        page.description.match(/^Imported from Focalboard card ([A-Za-z0-9_-]+)\b/m)![1],
        page,
      ]),
    );

    // Status options resolve through the synonym table; the board view's groupById is what
    // names the status property, no flag needed.
    expect(byCard.get("c-a")!.status).toBe("in_progress");
    expect(byCard.get("c-b")!.status).toBe("backlog");
    expect(byCard.get("c-d")!.status).toBe("done");
    // An explicit --option flag places the value the table has no name for.
    expect(byCard.get("c-g")!.status).toBe("ready");
    // No status at all is not a miss: Focalboard shows those under "No status".
    expect(byCard.get("c-c")!.status).toBe("backlog");
    // A status pointing at a deleted option is Focalboard's own loose end, carried with a
    // warning rather than refused.
    expect(byCard.get("c-f")!.status).toBe("backlog");
    expect(stdout).toContain("deleted option");

    // Content blocks walk the card's own contentOrder: text stays Markdown, adjacent
    // checkboxes stay one list, and what is not imported is counted, not hidden.
    const shipped = byCard.get("c-a")!;
    expect(shipped.description).toMatch(/^The plan\n\nDo it \*\*well\*\*\./);
    expect(shipped.description).toContain("- [x] write tests\n- [ ] write docs");
    expect(shipped.description).toContain("1 comment not imported.");
    expect(shipped.description).toContain("1 attachment/other block not imported.");

    // Every other property lands in the footer by name; selects resolve to their values,
    // dates to days, and person properties are skipped rather than dumped as opaque ids.
    expect(shipped.description).toContain("Priority: High.");
    expect(shipped.description).toContain(`Due: ${new Date(1755000000000).toISOString().slice(0, 10)}.`);
    expect(shipped.description).toContain("Context: started twice already.");
    expect(shipped.description).not.toContain("u123");

    // The card's own clocks survive, and a Done card carries its last update as the stated
    // completion proxy.
    expect(shipped.createdAt).toBe(iso(1750000000000));
    expect(shipped.updatedAt).toBe(iso(1755500000000));
    expect(byCard.get("c-d")!.completedAt).toBe(iso(1756000000000));

    // A blank title imports the way Focalboard renders one.
    expect(byCard.get("c-b")!.title).toBe("Untitled");

    // Templates are stationery, not work.
    expect(stdout).toContain("1 skipped");

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
    const served = workspace.pages.find((page: Page) => page.title === "Ship the importer")!;
    expect(served.status).toBe("in_progress");
    await restarted.close();
  });

  it("skips already-imported cards on a rerun instead of duplicating them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionImportTarget(server);
    const archivePath = writeArchive(singleBoardArchive);
    await server.close();

    await runOpsImporter(script, server, archivePath, [...withSomedayMapped, "--apply"]);
    const { stdout } = await runOpsImporter(script, server, archivePath, [...withSomedayMapped, "--apply"]);

    expect(stdout).toContain("0 to create");
    expect(importedPages(server)).toHaveLength(6);
  });

  it("refuses the whole import when a status value in use has no column, naming the flag to pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionImportTarget(server);
    const archivePath = writeArchive(singleBoardArchive);
    await server.close();

    const failure = await runOpsImporter(script, server, archivePath, ["--apply"]).catch((error) => error);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain('option "Someday Maybe"');
    expect(failure.stdout).toContain("--option");
    expect(importedPages(server)).toEqual([]);
  });

  it("reads an unzipped directory and a bare board.jsonl the same as the archive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionImportTarget(server);
    const extracted = mkdtempSync(join(tmpdir(), "focalboard-extracted-"));
    writeFileSync(join(extracted, "version.json"), '{"version":2,"date":1756000000000}');
    mkdirSync(join(extracted, "bd1"));
    const jsonlPath = join(extracted, "bd1", "board.jsonl");
    writeFileSync(jsonlPath, boardLines(board, blocks));
    await server.close();

    const fromDirectory = await runOpsImporter(script, server, extracted, withSomedayMapped);
    const fromJsonl = await runOpsImporter(script, server, jsonlPath, withSomedayMapped);

    expect(fromDirectory.stdout).toContain("6 to create");
    expect(fromJsonl.stdout).toContain("6 to create");
  });

  it("imports one board per run: a multi-board archive demands --board and honours it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provisionImportTarget(server);
    const second = { ...board, id: "bd2", title: "Second Board" };
    const archivePath = writeArchive([
      ["version.json", '{"version":2,"date":1756000000000}'],
      ["bd1/board.jsonl", boardLines(board, blocks)],
      ["bd2/board.jsonl", boardLines(second, [])],
    ]);
    await server.close();

    const failure = await runOpsImporter(script, server, archivePath, withSomedayMapped).catch(
      (error) => error,
    );
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain("--board");
    expect(failure.stderr).toContain("Second Board");

    const { stdout } = await runOpsImporter(script, server, archivePath, [
      ...withSomedayMapped,
      "--board",
      "Roadmap",
    ]);
    expect(stdout).toContain("6 to create");
  });
});
