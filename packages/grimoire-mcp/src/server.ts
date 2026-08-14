import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConflictError, GrimoireClient, GrimoireError, type Board, type Page } from "./client.js";
import {
  ResolutionError,
  categoryName,
  chapterName,
  columnLabel,
  resolveAssignee,
  resolveBlockers,
  resolveCategory,
  resolveChapter,
  resolvePage,
  resolveStatus,
} from "./resolve.js";

/**
 * The tools an agent gets, and deliberately the ones it does not.
 *
 * There is no archive, promote, or chapter-management tool here. That is not an oversight and
 * it is not a permission check either - the tools simply do not exist, so an agent never
 * learns they are possible and never spends a turn being refused. The server would refuse
 * them anyway; this keeps the surface honest about what the thing is for.
 *
 * The shape of the rule: an agent may add and refine, and only a person may destroy or
 * restructure.
 */

export function createServer(client: GrimoireClient): McpServer {
  const server = new McpServer(
    { name: "grimoire", version: "0.1.0" },
    {
      instructions:
        "Grimoire is a small collaborative work board. A unit of work is a page, and pages sit " +
        "in columns: Backlog, Up Next, In progress, Review, Done. Call grimoire_board first to " +
        "see the project's real categories, chapters and members before writing, and pass those " +
        "names rather than guessing. You can create and edit pages and ideas. You cannot " +
        "archive anything, promote an idea, or change chapters, categories or membership - " +
        "those are deliberately left to a person.",
    },
  );

  /** Tool results are text; this keeps every one of them shaped the same way. */
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  const failure = (error: unknown) => ({
    content: [{ type: "text" as const, text: describe(error) }],
    isError: true,
  });

  server.registerTool(
    "grimoire_board",
    {
      title: "Read the board",
      description:
        "The whole project as it stands: every page with its column, category, chapter, " +
        "assignee and blockers, plus the categories, chapters and members that exist. Call " +
        "this before writing, so names resolve to real things.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(renderBoard(await client.board()));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_search",
    {
      title: "Search the project",
      description:
        "Searches titles and note bodies across every column, the backlog, the idea garden, " +
        "completed work and archived pages. Use this to find a page's id before editing it.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum hits to return."),
      },
    },
    async ({ query, limit }) => {
      try {
        const results = await client.search(query, limit);
        if (results.hits.length === 0) return text(`Nothing matches "${query}".`);
        const lines = results.hits.map(
          (hit) =>
            `- [${hit.group}] ${hit.title} · ${hit.where}` +
            `${hit.assigneeName ? ` · ${hit.assigneeName}` : ""}` +
            `\n  id: ${hit.id}${hit.snippet ? `\n  ${hit.snippet}` : ""}`,
        );
        return text(`${results.total} match${results.total === 1 ? "" : "es"} for "${query}":\n${lines.join("\n")}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_create_page",
    {
      title: "Create a page",
      description:
        "Adds a unit of work. Category, chapter, assignee and blockers take the names a person " +
        "would use and are resolved for you. New pages land in the Backlog unless you say " +
        "otherwise, which is usually right: Up Next is meant to stay small.",
      inputSchema: {
        title: z.string().min(1).max(240).describe("The page title."),
        notes: z.string().max(20_000).optional().describe("Markdown notes for the body."),
        column: z
          .string()
          .optional()
          .describe("Backlog, Up Next, In progress, Review or Done. Defaults to Backlog."),
        category: z.string().optional().describe("A category name that exists in this project."),
        chapter: z.string().optional().describe("A chapter name, if the project uses chapters."),
        assignee: z.string().optional().describe("A member's name or email, or \"me\"."),
        blockedBy: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Page ids or exact titles this page is blocked by."),
      },
    },
    async (input) => {
      try {
        const board = await client.board();
        const body: Record<string, unknown> = { title: input.title };
        if (input.notes !== undefined) body.description = input.notes;
        if (input.column !== undefined) body.status = resolveStatus(input.column);
        if (input.category !== undefined) body.category = resolveCategory(board, input.category);
        if (input.chapter !== undefined) body.chapter = resolveChapter(board, input.chapter);
        if (input.assignee !== undefined) body.assigneeId = resolveAssignee(board, input.assignee);
        if (input.blockedBy !== undefined) body.blockedBy = resolveBlockers(board, input.blockedBy);

        const { page } = await client.createPage(body);
        return text(`Created "${page.title}" in ${columnLabel(page.status)}.\nid: ${page.id}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_update_page",
    {
      title: "Edit a page",
      description:
        "Changes a page that already exists. Only the fields you pass are touched. When you " +
        "rewrite the title or notes based on something you read earlier, pass what you read as " +
        "expectedTitle or expectedNotes: the write is then refused if a person changed that " +
        "field in the meantime, instead of silently replacing their words.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
        title: z.string().min(1).max(240).optional().describe("A new title."),
        notes: z.string().max(20_000).optional().describe("New Markdown notes, replacing the body."),
        expectedTitle: z
          .string()
          .max(240)
          .optional()
          .describe("The title you are editing from. The write is refused if it has since changed."),
        expectedNotes: z
          .string()
          .max(20_000)
          .optional()
          .describe("The notes you are editing from. The write is refused if they have since changed."),
        column: z.string().optional().describe("Move it to another column."),
        category: z.string().optional().describe("A category name, or \"none\" to clear it."),
        chapter: z.string().optional().describe("A chapter name, or \"none\" to clear it."),
        assignee: z.string().optional().describe("A member's name or email, \"me\", or \"nobody\"."),
        blockedBy: z.array(z.string()).max(20).optional().describe("Replaces the blocker list."),
      },
    },
    async (input) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, input.page);
        const body: Record<string, unknown> = {};

        // What the edit is written against. An explicit expectation is the honest one: it
        // comes from whenever the caller actually read the field, so a person who changed it
        // since then is protected. Falling back to the value read a moment ago only rules out
        // a collision inside this call, which is why the tool asks for the real one.
        if (input.title !== undefined) {
          body.title = input.title;
          body.expectedTitle = input.expectedTitle ?? target.title;
        }
        if (input.notes !== undefined) {
          body.description = input.notes;
          body.expectedDescription = input.expectedNotes ?? target.description;
        }
        if (input.column !== undefined) body.status = resolveStatus(input.column);
        if (input.category !== undefined) {
          body.category = isNone(input.category) ? null : resolveCategory(board, input.category);
        }
        if (input.chapter !== undefined) {
          body.chapter = isNone(input.chapter) ? null : resolveChapter(board, input.chapter);
        }
        if (input.assignee !== undefined) {
          body.assigneeId = isNobody(input.assignee) ? null : resolveAssignee(board, input.assignee);
        }
        if (input.blockedBy !== undefined) body.blockedBy = resolveBlockers(board, input.blockedBy);

        if (Object.keys(body).length === 0) return text("Nothing to change - no fields were given.");

        const { page } = await client.updatePage(target.id, body);
        return text(`Updated "${page.title}".\n${describePage(board, page)}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_move_page",
    {
      title: "Move a page to another column",
      description:
        "Moves a page between columns. This carries no text, so it can never collide with " +
        "someone editing the same page's notes.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
        column: z.string().min(1).describe("Backlog, Up Next, In progress, Review or Done."),
      },
    },
    async ({ page, column }) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, page);
        const status = resolveStatus(column);
        const { page: moved } = await client.updatePage(target.id, { status });
        return text(`Moved "${moved.title}" from ${columnLabel(target.status)} to ${columnLabel(moved.status)}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_list_ideas",
    {
      title: "Read the idea garden",
      description:
        "Ideas are possibilities the team has not committed to. They are kept apart from work " +
        "on purpose, and only a person turns one into a page.",
      inputSchema: {},
    },
    async () => {
      try {
        const { ideas } = await client.ideas();
        if (ideas.length === 0) return text("The idea garden is empty.");
        return text(
          ideas
            .map((idea) => `- [${idea.state}] ${idea.title}\n  id: ${idea.id}${idea.description ? `\n  ${firstLine(idea.description)}` : ""}`)
            .join("\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_create_idea",
    {
      title: "Plant an idea",
      description:
        "Captures a possibility without committing to it. It lands in the Inbox. Only a person " +
        "can promote an idea into work, which is the point of keeping the two apart.",
      inputSchema: {
        title: z.string().min(1).max(240).describe("The idea, in a sentence."),
        notes: z.string().max(20_000).optional().describe("Markdown notes."),
      },
    },
    async ({ title, notes }) => {
      try {
        const body: Record<string, unknown> = { title };
        if (notes !== undefined) body.description = notes;
        const { idea } = await client.createIdea(body);
        return text(`Planted "${idea.title}" in the idea inbox.\nid: ${idea.id}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

function isNone(value: string): boolean {
  const key = value.trim().toLowerCase();
  return key === "none" || key === "null" || key === "";
}

function isNobody(value: string): boolean {
  const key = value.trim().toLowerCase();
  return isNone(value) || key === "nobody" || key === "unassigned" || key === "no one";
}

function firstLine(value: string): string {
  const line = value.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function describePage(board: Board, page: Page): string {
  const parts = [`column: ${columnLabel(page.status)}`];
  const category = categoryName(board, page.category);
  if (category) parts.push(`category: ${category}`);
  const chapter = chapterName(board, page.chapter);
  if (chapter) parts.push(`chapter: ${chapter}`);
  if (page.assigneeName) parts.push(`assignee: ${page.assigneeName}`);
  if (page.blockedBy.length > 0) parts.push(`blocked by ${page.blockedBy.length}`);
  return `${parts.join(" · ")}\nid: ${page.id}`;
}

/**
 * The board as something an agent can act on: grouped by column, with the identifiers it will
 * need to edit anything, and the vocabulary the write tools accept.
 */
function renderBoard(board: Board): string {
  const sections: string[] = [
    `Project: ${board.project.name}`,
    `You are acting as: ${board.currentUser.name} <${board.currentUser.email}>`,
    "",
    `Categories: ${board.categories.map((category) => category.name).join(", ") || "none"}`,
    `Members: ${board.members.map((member) => `${member.name} <${member.email}>`).join(", ")}`,
  ];

  if (board.chapters.length > 0) {
    sections.push(
      `Chapters: ${board.chapters.map((chapter) => `${chapter.name} (${chapter.state})`).join(", ")}`,
    );
  }

  for (const status of ["backlog", "ready", "in_progress", "review", "done"]) {
    const pages = board.pages.filter((page) => page.status === status);
    sections.push("", `${columnLabel(status)} (${pages.length})`);
    if (pages.length === 0) {
      sections.push("  - empty");
      continue;
    }
    for (const page of pages) {
      const bits: string[] = [];
      const category = categoryName(board, page.category);
      if (category) bits.push(category);
      const chapter = chapterName(board, page.chapter);
      if (chapter) bits.push(`chapter: ${chapter}`);
      if (page.assigneeName) bits.push(page.assigneeName);
      if (page.blockedBy.length > 0) bits.push(`blocked by ${page.blockedBy.length}`);
      sections.push(`  - ${page.title}${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
      sections.push(`    id: ${page.id}`);
    }
  }

  return sections.join("\n");
}

/** Turns a failure into something an agent can act on rather than a stack trace. */
function describe(error: unknown): string {
  if (error instanceof ConflictError) {
    return `${error.message}\n\nStored version:\n${JSON.stringify(error.current, null, 2)}`;
  }
  if (error instanceof ResolutionError) return error.message;
  if (error instanceof GrimoireError) {
    if (error.status === 401) {
      return "Grimoire refused the token. It may have been revoked or expired - ask the project owner to issue a new one.";
    }
    if (error.status === 403) {
      return `Grimoire refused this: ${error.message}. Agents can create and edit pages and ideas, but archiving, promoting an idea, and changing the project's shape are left to a person.`;
    }
    if (error.status === 429) {
      return "Writing too quickly for this token's rate limit. Wait a moment and continue.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
