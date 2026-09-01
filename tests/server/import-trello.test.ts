import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardWorkspace, Page } from "../../shared/types";
import { importedPages, provisionImportTarget, runOpsImporter } from "../fixtures/importers";
import { ownerAccount, startTestServer } from "./test-server";

const script = join(__dirname, "..", "..", "ops", "import-trello.mjs");

type Server = Awaited<ReturnType<typeof startTestServer>>;

// Trello ids open with the creation time in hex; the importer decodes it into created_at.
const ideasCard = "66a1b2c30000000000000001";
const todoCard = "66a1b2c40000000000000002";
const doingCard = "66a1b2c50000000000000003";
const doneCard = "66a1b2c70000000000000005";
const archivedCard = "66a1b2c80000000000000006";
const archivedListCard = "66a1b2c90000000000000007";
const weirdListCard = "66a1b2ca0000000000000008";
const longTitleCard = "66a1b2cb0000000000000009";
const templateCard = "66a1b2cc000000000000000a";
const newlineCard = "66a1b2cd000000000000000b";
const longTitle = "A".repeat(250);

/**
 * The importer replicates the server's file format rather than importing it (ops scripts stay
 * dependency-free), so this suite is what holds the two in lockstep: everything the script
 * writes must load through the real MarkdownPageStore and the real board route. The fixture is
 * shaped like Trello's actual board export - lists with emoji in their names, archived cards,
 * an archived list, labels, members, checklists, a due date - because the whole point of this
 * importer is that a person hands it their export untouched.
 */
const trelloExport = {
  name: "Side Project",
  lists: [
    { id: "list-ideas", name: "Ideas 💡", closed: false, pos: 1 },
    { id: "list-todo", name: "To Do", closed: false, pos: 2 },
    { id: "list-doing", name: "Doing", closed: false, pos: 3 },
    { id: "list-weird", name: "Weird Pile", closed: false, pos: 4 },
    { id: "list-done", name: "Done ✅", closed: false, pos: 5 },
    { id: "list-old", name: "Old Stuff", closed: true, pos: 6 },
  ],
  cards: [
    {
      id: ideasCard,
      name: "Try the wizard theme",
      desc: "It could look **great**.",
      idList: "list-ideas",
      closed: false,
      pos: 1,
      labels: [
        { id: "lb1", name: "nice-to-have" },
        { id: "lb2", name: "Story" },
      ],
    },
    {
      id: longTitleCard,
      name: longTitle,
      desc: "",
      idList: "list-ideas",
      closed: false,
      pos: 2,
    },
    {
      id: todoCard,
      name: "Ship the launch checklist",
      desc: "",
      idList: "list-todo",
      closed: false,
      pos: 1,
      due: "2026-09-15T12:00:00.000Z",
      dueComplete: false,
    },
    {
      id: doingCard,
      name: "Wire up the importer",
      desc: "",
      idList: "list-doing",
      closed: false,
      pos: 1,
      idMembers: ["M1"],
    },
    {
      id: weirdListCard,
      name: "Waiting on the mockups",
      desc: "",
      idList: "list-weird",
      closed: false,
      pos: 1,
    },
    {
      id: doneCard,
      name: "Pick a name",
      desc: "Shipped the login page.",
      idList: "list-done",
      closed: false,
      pos: 1,
      dateLastActivity: "2026-07-01T10:00:00.000Z",
    },
    { id: archivedCard, name: "Abandoned idea", desc: "", idList: "list-todo", closed: true, pos: 2 },
    { id: archivedListCard, name: "Ancient work", desc: "", idList: "list-old", closed: false, pos: 1 },
    {
      id: templateCard,
      name: "Weekly report template",
      desc: "",
      idList: "list-todo",
      closed: false,
      pos: 3,
      isTemplate: true,
    },
    {
      id: newlineCard,
      name: "Two line\ncard name",
      desc: "",
      idList: "list-doing",
      closed: false,
      pos: 2,
    },
  ],
  checklists: [
    {
      id: "chk1",
      idCard: todoCard,
      name: "Launch list",
      pos: 1,
      checkItems: [
        { id: "ci1", name: "write tests", state: "complete", pos: 2 },
        { id: "ci2", name: "write docs", state: "incomplete", pos: 1 },
      ],
    },
  ],
  members: [{ id: "M1", username: "donavyn", fullName: "Donavyn Haley" }],
};

function writeExport(board: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "trello-export-")), "board.json");
  writeFileSync(path, JSON.stringify(board));
  return path;
}

function provision(server: Server) {
  return provisionImportTarget(server, ["Bug", "Story"]);
}

const withWeirdPileMapped = ["--list", "Weird Pile=Review"];

describe("ops/import-trello.mjs", () => {
  it("dry-runs by default: validates every card and writes nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provision(server);
    const exportPath = writeExport(trelloExport);
    await server.close();

    const { stdout } = await runOpsImporter(script, server, exportPath, withWeirdPileMapped);

    expect(stdout).toContain("7 to create");
    expect(stdout).toContain("Dry run - nothing written");
    expect(importedPages(server)).toEqual([]);
  });

  it("applies the export so the real store and the real board load every card", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    const projectId = await provision(server);
    const exportPath = writeExport(trelloExport);
    await server.close();

    const { stdout } = await runOpsImporter(script, server, exportPath, [...withWeirdPileMapped, "--apply"]);
    expect(stdout).toContain("Wrote 7 page file(s)");

    const pages = importedPages(server);
    expect(pages).toHaveLength(7);
    const byCard = new Map(
      pages.map((page) => [page.description.match(/^Imported from Trello card ([0-9a-f]{24})\b/m)![1], page]),
    );

    // List names resolve through the synonym table, emoji and all.
    expect(byCard.get(ideasCard)!.status).toBe("backlog");
    expect(byCard.get(todoCard)!.status).toBe("ready");
    expect(byCard.get(doingCard)!.status).toBe("in_progress");
    expect(byCard.get(doneCard)!.status).toBe("done");
    // An explicit --list flag places the list the table has no name for.
    expect(byCard.get(weirdListCard)!.status).toBe("review");

    // The label matching a project category becomes the category; every label survives in
    // the footer.
    const ideas = byCard.get(ideasCard)!;
    expect(ideas.category).toBe("story");
    expect(ideas.description).toMatch(/^It could look \*\*great\*\*\./);
    expect(ideas.description).toContain("Labels: nice-to-have, Story.");

    // Checklists keep their headings, their order and their ticks; the due date survives.
    const todo = byCard.get(todoCard)!;
    expect(todo.description).toContain("### Launch list\n\n- [ ] write docs\n- [x] write tests");
    expect(todo.description).toContain("Due 2026-09-15.");

    // Member names are provenance, never a guessed assignee.
    const doing = byCard.get(doingCard)!;
    expect(doing.description).toContain("Members on the card: Donavyn Haley (@donavyn).");
    expect(doing.assignee).toBeNull();

    // created_at is decoded from the card id, and a Done card carries its last activity as
    // the stated completion proxy.
    const created = new Date(Number.parseInt(ideasCard.slice(0, 8), 16) * 1000)
      .toISOString()
      .replace(".000Z", "Z");
    expect(ideas.createdAt).toBe(created);
    const done = byCard.get(doneCard)!;
    expect(done.completedAt).toBe("2026-07-01T10:00:00Z");
    expect(done.updatedAt).toBe("2026-07-01T10:00:00Z");

    // A name past the board's 240-character limit is shortened, not refused, and survives
    // whole as the story's first line.
    const long = byCard.get(longTitleCard)!;
    expect(long.title).toBe(`${longTitle.slice(0, 237)}...`);
    expect(long.description).toMatch(new RegExp(`^${longTitle}$`, "m"));
    expect(stdout).toContain("shortened");

    // Backlog positions append after the page that predates the import, in list order.
    expect(ideas.position).toBe(1);
    expect(long.position).toBe(2);

    // Trello's archive stays behind - archived cards and cards on an archived list alike -
    // and so do card templates, which are stationery, not work.
    expect(byCard.has(archivedCard)).toBe(false);
    expect(byCard.has(archivedListCard)).toBe(false);
    expect(byCard.has(templateCard)).toBe(false);
    expect(stdout).toContain("3 skipped");

    // A name with a newline in it (real exports carry them) becomes one honest line.
    expect(byCard.get(newlineCard)!.title).toBe("Two line card name");

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
    expect(workspace.pages).toHaveLength(8);
    const served = workspace.pages.find((page: Page) => page.title === "Try the wizard theme")!;
    expect(served.status).toBe("backlog");
    await restarted.close();
  });

  it("skips already-imported cards on a rerun instead of duplicating them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provision(server);
    const exportPath = writeExport(trelloExport);
    await server.close();

    await runOpsImporter(script, server, exportPath, [...withWeirdPileMapped, "--apply"]);
    const { stdout } = await runOpsImporter(script, server, exportPath, [...withWeirdPileMapped, "--apply"]);

    expect(stdout).toContain("0 to create");
    expect(importedPages(server)).toHaveLength(7);
  });

  it("refuses the whole import when a list with cards has no column, naming the flag to pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provision(server);
    const exportPath = writeExport(trelloExport);
    await server.close();

    const failure = await runOpsImporter(script, server, exportPath, ["--apply"]).catch((error) => error);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain('list "Weird Pile"');
    expect(failure.stdout).toContain("--list");
    expect(importedPages(server)).toEqual([]);
  });

  it("does not demand a mapping for an empty leftover list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grimoire-import-"));
    const server = await startTestServer(directory);
    await provision(server);
    const exportPath = writeExport({
      ...trelloExport,
      cards: trelloExport.cards.filter((card) => card.idList !== "list-weird"),
    });
    await server.close();

    const { stdout } = await runOpsImporter(script, server, exportPath);

    expect(stdout).toContain("6 to create");
    expect(stdout).toContain("0 error(s)");
  });
});
