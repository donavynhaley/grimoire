import { z } from "zod";
import { IDEA_STATE_LABELS, PAGE_STATUS_LABELS, type SearchHit } from "../../shared/types";
import { DEMO_STORAGE_KEY, demoAssets, setDemoStorageNotice } from "./mode";
import { type DemoState, seedDemo } from "./seed";
import { settingsRequest } from "./settings";
import { DemoError, requireDemo, workRequest } from "./work";

const commandSchema = z
  .object({
    path: z.string().max(500),
    project: z.string().nullable(),
    method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
    body: z.unknown(),
    at: z.iso.datetime(),
  })
  .strict();
const journalSchema = z
  .object({ version: z.literal(1), commands: z.array(commandSchema).max(1000) })
  .strict();
type Command = z.infer<typeof commandSchema>;
const MUTATION_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/(?:pages|ideas|projects|categories|fields|chapters|images)$/],
  ["POST", /^\/api\/pages\/[^/]+\/(?:restore|discussion)$/],
  ["POST", /^\/api\/pages\/[^/]+\/discussion\/[^/]+\/(?:replies|answered)$/],
  [
    "POST",
    /^\/api\/(?:ideas\/[^/]+\/promote|projects\/[^/]+\/restore|chapters\/[^/]+\/close|account\/name)$/,
  ],
  ["PATCH", /^\/api\/(?:pages|ideas|projects|categories|fields|chapters|members)\/[^/]+$/],
  ["DELETE", /^\/api\/(?:pages|projects|categories|fields|chapters|members)\/[^/]+$/],
  ["DELETE", /^\/api\/ideas\/[^/]+\/promotion$/],
  ["PUT", /^\/api\/account\/avatar$/],
  ["DELETE", /^\/api\/account\/avatar$/],
];

type DemoStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Replay validated local commands, so stale or tampered storage never becomes a trusted API response. */
export class DemoStore {
  private state: DemoState = seedDemo();
  private commands: Command[] = [];
  constructor(private readonly storage?: DemoStorage) {
    try {
      const saved = storage?.getItem(DEMO_STORAGE_KEY);
      if (!saved) return;
      if (saved.length > 4_000_000) throw new Error("Demo storage too large");
      const journal = journalSchema.parse(JSON.parse(saved));
      for (const command of journal.commands) this.apply(command);
      this.commands = journal.commands;
    } catch {
      this.state = seedDemo();
      this.commands = [];
      try {
        storage?.removeItem(DEMO_STORAGE_KEY);
      } catch {
        /* The demo still works in memory. */
      }
      setDemoStorageNotice("Saved demo changes could not be loaded. A fresh playground is ready.");
    }
    this.syncAssets();
  }
  private syncAssets(): void {
    demoAssets.clear();
    for (const [name, source] of Object.entries(this.state.assets)) demoAssets.set(name, source);
  }
  private apply(command: Command): unknown {
    if (
      !MUTATION_ROUTES.some(([method, pattern]) => method === command.method && pattern.test(command.path))
    ) {
      throw new DemoError("This feature needs your own Grimoire installation. No request was sent.", 403);
    }
    const path = command.path.split("/");
    const project = requireDemo(
      this.state.projects.find((item) => item.board.project.id === command.project && !item.archivedAt) ??
        this.state.projects.find((item) => !item.archivedAt),
    );
    if (path[2] === "pages" || path[2] === "ideas")
      return workRequest(this.state, project, path, command.method, command.body, command.at);
    return settingsRequest(this.state, project, path, command.method, command.body, command.at);
  }
  reset(): void {
    this.state = seedDemo();
    this.commands = [];
    this.syncAssets();
    try {
      this.storage?.removeItem(DEMO_STORAGE_KEY);
      setDemoStorageNotice("");
    } catch {
      setDemoStorageNotice("Changes last until this page closes because browser storage is unavailable.");
    }
  }
  request(path: string, method: string, body: unknown, projectId: string | null): unknown {
    const url = new URL(path, "https://demo.invalid");
    if (url.origin !== "https://demo.invalid" || !url.pathname.startsWith("/api/"))
      throw new DemoError("The demo cannot send requests outside its local playground.", 403);
    const project = requireDemo(
      this.state.projects.find((item) => item.board.project.id === projectId && !item.archivedAt) ??
        this.state.projects.find((item) => !item.archivedAt),
    );
    const board = project.board;
    if (method === "GET") {
      switch (url.pathname) {
        case "/api/session":
          return { status: "authenticated", user: { ...board.currentUser } };
        case "/api/board": {
          const visible = structuredClone(board);
          visible.projects = this.state.projects
            .filter((item) => !item.archivedAt)
            .map((item) => ({
              id: item.board.project.id,
              name: item.board.project.name,
              description: item.board.project.description,
            }));
          for (const page of visible.pages)
            page.openThreads = (project.discussions[page.id] ?? []).filter(
              (thread) => !thread.answeredAt,
            ).length;
          visible.pages.sort((a, b) => a.position - b.position);
          visible.categories.sort((a, b) => a.position - b.position);
          visible.fields.sort((a, b) => a.position - b.position);
          visible.chapters = visible.project.chaptersEnabled
            ? visible.chapters.sort((a, b) => a.position - b.position)
            : [];
          visible.velocity = visible.project.estimatesEnabled
            ? visible.chapters.map((chapter) => {
                const pages = visible.pages.filter((page) => page.chapter === chapter.slug);
                const done = pages.filter((page) => page.status === "done");
                const open = pages.filter((page) => page.status !== "done");
                return {
                  slug: chapter.slug,
                  donePages: chapter.deliveredPages ?? done.length,
                  doneEstimate: chapter.deliveredEstimate ?? done.reduce((n, p) => n + (p.estimate ?? 0), 0),
                  openPages: chapter.carriedPages ?? open.length,
                  openEstimate: chapter.carriedEstimate ?? open.reduce((n, p) => n + (p.estimate ?? 0), 0),
                  unestimatedPages: pages.filter((page) => page.estimate === null).length,
                  recorded: chapter.state === "closed",
                };
              })
            : [];
          return visible;
        }
        case "/api/ideas":
          return structuredClone({
            project: board.project,
            currentUser: board.currentUser,
            ideas: project.ideas,
          });
        case "/api/activity": {
          const entity = url.searchParams.get("entity");
          const before = Number(url.searchParams.get("before") ?? Infinity);
          const events = project.events
            .filter((item) => (!entity || item.entityId === entity) && item.sequence < before)
            .reverse();
          return structuredClone({ events: events.slice(0, 40), hasMore: events.length > 40 });
        }
        case "/api/away":
          return { since: 0, latest: project.events.length, total: 0, events: [] };
        case "/api/agent-review":
          return { since: 0, latest: 0, total: 0, events: [], waiting: [], credentials: [] };
        case "/api/agent-tokens":
          return { tokens: [] };
        case "/api/github/pulls":
          return { pulls: [] };
        case "/api/projects/archived":
          return {
            projects: this.state.projects
              .filter((item) => item.archivedAt)
              .map((item) => ({ ...item.board.project, archivedAt: item.archivedAt })),
          };
        case "/api/search": {
          const query = (url.searchParams.get("q") ?? "").trim();
          const term = query.toLowerCase();
          const hits: SearchHit[] = [];
          for (const page of [...board.pages, ...project.archivedPages]) {
            if (!term || !`${page.title} ${page.description}`.toLowerCase().includes(term)) continue;
            const archived = project.archivedPages.includes(page);
            hits.push({
              kind: "page",
              group: archived
                ? "archived"
                : page.status === "done"
                  ? "done"
                  : page.status === "backlog"
                    ? "backlog"
                    : "active",
              id: page.id,
              title: page.title,
              snippet: page.description.slice(0, 160),
              where: archived ? "Archived" : PAGE_STATUS_LABELS[page.status],
              category: page.category,
              categoryColor: board.categories.find((item) => item.slug === page.category)?.color ?? null,
              assigneeName: page.assigneeName,
            });
          }
          for (const idea of project.ideas)
            if (term && `${idea.title} ${idea.description}`.toLowerCase().includes(term))
              hits.push({
                kind: "idea",
                group: "ideas",
                id: idea.id,
                title: idea.title,
                snippet: idea.description.slice(0, 160),
                where: IDEA_STATE_LABELS[idea.state],
                category: null,
                categoryColor: null,
                assigneeName: null,
              });
          return { query, total: hits.length, hits: hits.slice(0, 100) };
        }
      }
      return structuredClone(
        workRequest(this.state, project, url.pathname.split("/"), method, body, new Date().toISOString()),
      );
    }
    if (method === "POST" && ["/api/seen", "/api/agent-review/seen"].includes(url.pathname))
      return { ok: true };
    if (method === "POST" && /^\/api\/pages\/[^/]+\/discussion\/seen$/.test(url.pathname))
      return { ok: true };
    const command = commandSchema.parse({
      path: url.pathname,
      method,
      body,
      project: board.project.id,
      at: new Date().toISOString(),
    });
    const previous = structuredClone(this.state);
    try {
      const result = structuredClone(this.apply(command));
      this.commands.push(command);
      this.syncAssets();
      try {
        const saved = JSON.stringify({ version: 1, commands: this.commands });
        if (!this.storage || saved.length > 4_000_000 || this.commands.length > 1000)
          throw new Error("Storage unavailable or full");
        this.storage.setItem(DEMO_STORAGE_KEY, saved);
      } catch {
        setDemoStorageNotice(
          "Browser storage is unavailable or full. Further changes last only until you refresh.",
        );
      }
      return result;
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
}
let instance: DemoStore | undefined;
export function browserDemoStore(): DemoStore {
  if (!instance) {
    let storage: Storage | undefined;
    try {
      storage = globalThis.sessionStorage;
    } catch {
      setDemoStorageNotice("Browser storage is unavailable. Changes last only until you refresh.");
    }
    instance = new DemoStore(storage);
  }
  return instance;
}
export async function demoResponse(
  path: string,
  init: RequestInit,
  projectId: string | null,
): Promise<Response> {
  try {
    let body: unknown = {};
    if (init.body instanceof Blob) {
      if (init.body.size > 2_000_000) throw new DemoError("Keep demo images under 2 MB.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("Image could not be read"));
        reader.onerror = () => reject(new Error("Image could not be read"));
        reader.readAsDataURL(init.body as Blob);
      });
      body = { dataUrl };
    } else if (typeof init.body === "string") body = JSON.parse(init.body);
    const result = browserDemoStore().request(path, init.method ?? "GET", body, projectId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof DemoError)
      return Response.json({ error: error.message, ...error.details }, { status: error.status });
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: error.issues
            .map((issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`)
            .join("; "),
        },
        { status: 400 },
      );
    return Response.json(
      { error: "The demo could not apply that change. Try again or reset the playground." },
      { status: 400 },
    );
  }
}
