import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ConflictError,
  GrimoireClient,
  GrimoireError,
  type Board,
  type DiscussionThread,
  type Page,
} from "./client.js";
import {
  ResolutionError,
  categoryName,
  chapterName,
  columnLabel,
  fieldSummary,
  resolveAssignee,
  resolveBlockers,
  resolveCategory,
  resolveChapter,
  resolveFields,
  resolvePage,
  resolveStatus,
} from "./resolve.js";

/**
 * How long a body may be, mirroring `BODY_MAX_LENGTH` in the server's shared/types.ts.
 *
 * Duplicated rather than imported because this package ships to npm on its own and takes no
 * dependency on the application source. The server is the one that enforces it; this copy only
 * saves an agent a round trip to be told the same thing. They must move together.
 */
const BODY_MAX_LENGTH = 50_000;

/** What a field patch looks like coming from an agent. `null` clears one. */
const fieldPatch = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(
    "This project's own fields, by name. Values are checked against the field: a choice field " +
      "only takes one of its options. Pass null to clear one. Call grimoire_board to see which " +
      "fields exist.",
  );

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

export type ServerOptions = {
  /**
   * The credential's scope, read from the server at startup. A read-only credential is
   * given only the reading tools, so it never has to discover its limits by being refused.
   */
  scope?: "read" | "write";
};

export function createServer(client: GrimoireClient, options: ServerOptions = {}): McpServer {
  const writable = options.scope !== "read";
  const server = new McpServer(
    { name: "grimoire", version: "0.3.0" },
    {
      instructions:
        "Grimoire is a small collaborative work board. A unit of work is a page, and pages sit " +
        "in columns: Backlog, Up Next, In progress, Review, Done. Call grimoire_board first to " +
        "see the project's real categories, chapters and members before writing, and pass those " +
        "names rather than guessing. " +
        (writable
          ? "A project may also define its own fields - a priority, an estimate, whatever it " +
            "tracks - and you can fill those in on any page. You can create and edit pages and " +
            "ideas, and place a page into an existing chapter or take it out of one. " +
            "Every page also has a discussion beside it, and that is where you report: post " +
            "what you did, what you found, and what you need decided with " +
            "grimoire_post_in_discussion rather than writing it into the notes, because the " +
            "notes are the brief somebody wrote for the work and rewriting them destroys what " +
            "you were working from. Read grimoire_read_discussion before you start on a page " +
            "and again before you finish: an open thread is a question a person is waiting on " +
            "you for, and it appears nowhere in the page itself. Answer one in the thread it " +
            "was asked in with grimoire_reply_in_discussion. You cannot mark a thread " +
            "answered - that is a person's judgement, and an agent that could close its own " +
            "question could report its own work settled. " +
            "When a page " +
            "is delivered by a pull request, tie the two together with grimoire_update_page's " +
            "github argument rather than writing the link into the notes: Grimoire tracks it from " +
            "there, and the page moves itself into Review when the pull request opens and into " +
            "Done when it merges. You cannot " +
            "archive anything, promote an idea, create or rename fields, or create, rename, open " +
            "or close chapters - and categories, membership and the project's settings are closed " +
            "too. Those are deliberately left to a person. Before rewriting a page's title or " +
            "notes, read them with grimoire_read_page and pass what you read as expectedTitle or " +
            "expectedNotes."
          : "This credential is read-only: you can read the board, search, list ideas, and read " +
            "the discussion on any page, and nothing here can write. Ask the project owner for " +
            "a write-scoped credential if this agent should create or edit work, or report in " +
            "a page's discussion."),
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
        "assignee, blockers and field values, plus the categories, chapters, fields and members " +
        "that exist. Call this before writing, so names resolve to real things.",
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
        return text(
          `${results.total} match${results.total === 1 ? "" : "es"} for "${query}":\n${lines.join("\n")}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_read_page",
    {
      title: "Read one page in full",
      description:
        "A page's title and complete Markdown notes, exactly as stored. Read a page with this " +
        "before rewriting its title or notes: the exact values returned here are what you pass " +
        "as expectedTitle / expectedNotes, so a person editing at the same time is protected.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
      },
    },
    async ({ page }) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, page);
        return text(
          `# ${target.title}\n${describePage(board, target)}\n\n` +
            (target.description ? `Notes (verbatim):\n${target.description}` : "No notes yet."),
        );
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
            .map(
              (idea) =>
                `- [${idea.state}] ${idea.title}\n  id: ${idea.id}${idea.description ? `\n  ${firstLine(idea.description)}` : ""}`,
            )
            .join("\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_read_discussion",
    {
      title: "Read the discussion on a page",
      description:
        "Everything people have said about one page, thread by thread, with what is still " +
        "open and what has been answered, and who each message named with an @. Read this before you start work on a page and " +
        "again before you report on it: an open thread is a question somebody is waiting on " +
        "you for, and it will not appear in the page's notes. Answer one with " +
        "grimoire_reply_in_discussion.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
      },
    },
    async ({ page }) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, page);
        const { threads } = await client.discussion(target.id);
        if (threads.length === 0) return text(`Nothing has been said on "${target.title}" yet.`);
        const open = threads.filter((thread) => thread.answeredAt === null);
        const answered = threads.filter((thread) => thread.answeredAt !== null);
        const lines = [
          `# Discussion on ${target.title}`,
          `${open.length} open, ${answered.length} answered.`,
          "",
          ...threads.map(describeThread),
        ];
        return text(lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    },
  );

  if (!writable) return server;

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
        notes: z.string().max(BODY_MAX_LENGTH).optional().describe("Markdown notes for the body."),
        column: z
          .string()
          .optional()
          .describe("Backlog, Up Next, In progress, Review or Done. Defaults to Backlog."),
        category: z.string().optional().describe("A category name that exists in this project."),
        chapter: z.string().optional().describe("A chapter name, if the project uses chapters."),
        assignee: z.string().optional().describe('A member\'s name or email, or "me".'),
        blockedBy: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Page ids or exact titles this page is blocked by."),
        fields: fieldPatch.optional(),
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
        if (input.fields !== undefined) body.fields = resolveFields(board, input.fields);

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
        "Changes a page that already exists. Only the fields you pass are touched. Rewriting " +
        "the title requires expectedTitle, and rewriting the notes requires expectedNotes: " +
        "the value you read from grimoire_read_page. The write is refused if a person changed " +
        "that field after you read it, instead of silently replacing their words.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
        title: z.string().min(1).max(240).optional().describe("A new title. Requires expectedTitle."),
        notes: z
          .string()
          .max(BODY_MAX_LENGTH)
          .optional()
          .describe("New Markdown notes, replacing the whole body. Requires expectedNotes."),
        expectedTitle: z
          .string()
          .max(240)
          .optional()
          .describe("The title you read before deciding to rewrite it, verbatim from grimoire_read_page."),
        expectedNotes: z
          .string()
          .max(BODY_MAX_LENGTH)
          .optional()
          .describe("The notes you read before deciding to rewrite them, verbatim from grimoire_read_page."),
        column: z.string().optional().describe("Move it to another column."),
        category: z.string().optional().describe('A category name, or "none" to clear it.'),
        chapter: z.string().optional().describe('A chapter name, or "none" to clear it.'),
        assignee: z.string().optional().describe('A member\'s name or email, "me", or "nobody".'),
        blockedBy: z.array(z.string()).max(20).optional().describe("Replaces the blocker list."),
        fields: fieldPatch.optional(),
        github: z
          .string()
          .max(400)
          .nullable()
          .optional()
          .describe(
            'The GitHub work this page is tied to: a pull request URL, "#123", a branch URL, ' +
              "or a branch name. Pass null to unlink. Grimoire then tracks it - the page moves " +
              "itself to Review when the pull request opens and to Done when it merges, so " +
              "linking is usually better than moving the page by hand.",
          ),
      },
    },
    async (input) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, input.page);
        const body: Record<string, unknown> = {};

        // A text rewrite must declare what it was written against. Falling back to a value
        // read inside this call would compare the field against a copy of itself from
        // microseconds ago - a check that can never fire, which is last-writer-wins wearing
        // a safety's clothes. Refusing here is what makes the protection real.
        if (input.title !== undefined) {
          if (input.expectedTitle === undefined) {
            return failure(
              new ResolutionError(
                "Rewriting the title needs expectedTitle: the title as you last read it. " +
                  `Call grimoire_read_page on "${target.title}" and pass the title it returns.`,
              ),
            );
          }
          body.title = input.title;
          body.expectedTitle = input.expectedTitle;
        }
        if (input.notes !== undefined) {
          if (input.expectedNotes === undefined) {
            return failure(
              new ResolutionError(
                "Rewriting the notes needs expectedNotes: the notes as you last read them. " +
                  `Call grimoire_read_page on "${target.title}" and pass the notes it returns, verbatim.`,
              ),
            );
          }
          body.description = input.notes;
          body.expectedDescription = input.expectedNotes;
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
        // A patch, so naming one field leaves the rest of them alone.
        if (input.fields !== undefined) body.fields = resolveFields(board, input.fields);
        // Passed through as written rather than parsed here: the server owns what reads as a
        // pull request, and a second opinion in this package would drift from it. `null`
        // survives the round trip because unlinking has to stay expressible.
        if (input.github !== undefined) body.github = input.github;

        if (Object.keys(body).length === 0) return text("Nothing to change - nothing was given.");

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
        return text(
          `Moved "${moved.title}" from ${columnLabel(target.status)} to ${columnLabel(moved.status)}.`,
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
        notes: z.string().max(BODY_MAX_LENGTH).optional().describe("Markdown notes."),
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

  server.registerTool(
    "grimoire_post_in_discussion",
    {
      title: "Say something on a page",
      description:
        "Opens a thread on a page. This is how you report: what you did, what you found, what " +
        "you need decided, what you are about to do. Use it in preference to editing the " +
        "notes - the notes are the brief somebody wrote for this work, and rewriting them to " +
        "say what you did destroys the thing you were working from. A thread stays open until " +
        "a person marks it answered, so raising a question here means somebody will see that " +
        "you are waiting. Write it as one message a teammate could act on, not a log.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
        body: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe(
            "What you want to say. Plain prose; one message, not a transcript. Write @ and " +
              "somebody's name, exactly as grimoire_board gives it, to address them - Grimoire " +
              "resolves it and tells them it was for them. Use it when you need a particular " +
              "person, not on every message.",
          ),
      },
    },
    async ({ page, body }) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, page);
        const { thread } = await client.openThread(target.id, body);
        return text(
          `Posted on "${target.title}". Thread ${thread.id} is open until a person marks it ` +
            "answered; you cannot close it yourself.",
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "grimoire_reply_in_discussion",
    {
      title: "Answer a thread on a page",
      description:
        "Replies to a thread somebody opened. Use this when a person asked you something: " +
        "read the page's discussion first, then answer in the thread the question was asked " +
        "in rather than opening a new one. Replying does not close the thread - saying " +
        "something and having said enough are different claims, and only a person decides " +
        "the second one.",
      inputSchema: {
        page: z.string().min(1).describe("The page id, or its exact title."),
        thread: z.string().min(1).describe("The thread id, from grimoire_read_discussion."),
        body: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("Your answer. @ and a member's name addresses them, as in a new thread."),
      },
    },
    async ({ page, thread, body }) => {
      try {
        const board = await client.board();
        const target = resolvePage(board, page);
        const { threads } = await client.discussion(target.id);
        const known = threads.find((candidate) => candidate.id === thread);
        if (!known) {
          throw new Error(
            `No thread ${thread} on "${target.title}". Call grimoire_read_discussion to see the ` +
              "threads it has, and pass the id it returns.",
          );
        }
        await client.replyToThread(target.id, thread, body);
        return text(`Replied on "${target.title}". The thread stays open until a person marks it answered.`);
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

/**
 * One thread, rendered so an agent can tell at a glance whether it is being waited on.
 *
 * The state leads, because it is the only thing that decides whether this thread is the
 * agent's problem. The id follows it, because replying needs one.
 */
function describeThread(thread: DiscussionThread): string {
  const who = (message: { authorName: string; agentName: string | null }) =>
    message.agentName ? `${message.authorName} (via ${message.agentName})` : message.authorName;
  const head = thread.answeredAt
    ? `- [answered${thread.answeredByName ? ` by ${thread.answeredByName}` : ""}]`
    : "- [OPEN]";
  return [
    `${head} ${who(thread)}: ${thread.body}`,
    `  id: ${thread.id}`,
    ...thread.replies.map((reply) => `  ↳ ${who(reply)}: ${reply.body}`),
  ].join("\n");
}

function firstLine(value: string): string {
  const line = value.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * A page's GitHub link, if it has one.
 *
 * Reading this matters as much as writing it: an agent that cannot see a page is already
 * linked will either link it a second time or fall back to pasting the URL into the notes,
 * which is the habit the field exists to replace. The URL is worth the room on one page and
 * not on a board of them, so the caller says which it wants.
 */
function githubSummary(page: Page, options: { url?: boolean } = {}): string | null {
  const link = page.github;
  if (!link) return null;
  const named = link.kind === "pr" ? `PR #${link.number}` : `branch ${link.name}`;
  const where = link.repo ? ` in ${link.repo}` : "";
  const status = page.githubStatus;
  if (!status || status.state === "unchecked") return `github: ${named}${where}`;
  // A branch link adopts whichever pull request has it as its head, so name the one it found.
  const adopted = link.kind === "branch" && status.prNumber ? ` (PR #${status.prNumber})` : "";
  const url = options.url && status.prUrl ? ` ${status.prUrl}` : "";
  return `github: ${named}${where}${adopted} - ${status.state}${url}`;
}

function describePage(board: Board, page: Page): string {
  const parts = [`column: ${columnLabel(page.status)}`];
  const category = categoryName(board, page.category);
  if (category) parts.push(`category: ${category}`);
  const chapter = chapterName(board, page.chapter);
  if (chapter) parts.push(`chapter: ${chapter}`);
  if (page.assigneeName) parts.push(`assignee: ${page.assigneeName}`);
  if (page.blockedBy.length > 0) parts.push(`blocked by ${page.blockedBy.length}`);
  parts.push(...fieldSummary(board, page.fields));
  const github = githubSummary(page, { url: true });
  if (github) parts.push(github);
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

  // Named with their permitted values, because a field an agent cannot see the options for
  // is one it will guess at and be refused over.
  if (board.fields && board.fields.length > 0) {
    sections.push(
      `Fields: ${board.fields
        .map(
          (field) =>
            `${field.label} (${field.type === "select" || field.type === "search-select" ? field.options.join(" | ") : field.type})`,
        )
        .join(", ")}`,
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
      bits.push(...fieldSummary(board, page.fields));
      const github = githubSummary(page);
      if (github) bits.push(github);
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
      // Two different refusals share the status code, and explaining the wrong one would
      // assert the exact capability that was just refused.
      if (/read-only/i.test(error.message)) {
        return (
          "Grimoire refused the write: this credential is read-only. The reading tools still " +
          "work. Ask the project owner for a write-scoped credential if this agent should write."
        );
      }
      return `Grimoire refused this: ${error.message}. Archiving, promoting an idea, and managing chapters, categories or membership are left to a person.`;
    }
    if (error.status === 429) {
      return "Writing too quickly for this token's rate limit. Wait a moment and continue.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
