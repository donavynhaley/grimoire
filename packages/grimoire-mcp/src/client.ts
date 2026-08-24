/**
 * A thin HTTP client for one Grimoire project.
 *
 * Everything this server does goes through the same routes a browser uses. It never touches
 * the SQLite file or the Markdown directory, because doing so would skip the audit log, the
 * live broadcast, the dependency checks and the compare-and-swap that make a write safe -
 * and because one process is meant to own a project directory at a time.
 */

export type FieldValue = string | number | boolean;

export type ProjectField = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "search-select" | "date" | "checkbox";
  options: string[];
  showOnTile: boolean;
};

/**
 * The GitHub work a page is tied to. Mirrors `PageGithubLink` in the server's shared/types.ts,
 * duplicated for the same reason the body limit is: this package ships to npm on its own and
 * takes no dependency on the application source. They must move together.
 */
export type PageGithubLink =
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "branch"; name: string; repo?: string };

/** What GitHub last said about a linked page, cached server-side between polls. */
export type PageGithubStatus = {
  state: "open" | "draft" | "merged" | "closed" | "missing" | "unchecked";
  /** Present once a pull request exists, including one adopted for a branch link. */
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  checkedAt: string | null;
};

export type Page = {
  /** How many threads on this page are still waiting for an answer. */
  openThreads?: number;
  id: string;
  title: string;
  description: string;
  category: string | null;
  chapter: string | null;
  /** Values for the project's own fields. Absent keys were never filled in. */
  fields: Record<string, FieldValue>;
  blockedBy: string[];
  status: string;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /**
   * The GitHub work this page is tied to, or null. Optional rather than required because a
   * Grimoire older than the feature serves neither key, and a client that ships separately
   * from the server it talks to has to keep reading one.
   */
  github?: PageGithubLink | null;
  /** What GitHub last said about that link; null when the page has none. */
  githubStatus?: PageGithubStatus | null;
};

export type DiscussionMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  /** The agent that wrote this on its issuer's behalf, or null for a person. */
  agentName: string | null;
  body: string;
  createdAt: string;
};

/**
 * A question and what came back.
 *
 * answeredAt is the whole state a thread has, and only a person may set it - an agent that
 * could close the question it raised could report its own work settled.
 */
export type DiscussionThread = DiscussionMessage & {
  replies: DiscussionMessage[];
  answeredAt: string | null;
  answeredByName: string | null;
};

export type Board = {
  project: { id: string; name: string; chaptersEnabled?: boolean };
  categories: Array<{ slug: string; name: string; color: string }>;
  chapters: Array<{ slug: string; name: string; state: string; description: string }>;
  /** Optional so an older Grimoire, which serves no fields at all, still parses. */
  fields?: ProjectField[];
  members: Array<{ id: string; name: string; email: string }>;
  currentUser: { id: string; name: string; email: string };
  pages: Page[];
};

export type Idea = {
  id: string;
  title: string;
  description: string;
  state: string;
};

export type SearchResults = {
  query: string;
  total: number;
  hits: Array<{
    kind: string;
    group: string;
    id: string;
    title: string;
    snippet: string;
    where: string;
    category: string | null;
    assigneeName: string | null;
  }>;
};

/** A refused write, carrying whatever the server says is actually stored. */
export class ConflictError extends Error {
  constructor(
    readonly field: string,
    readonly current: unknown,
  ) {
    super(
      `The ${field} changed in Grimoire since this was read. The stored version is included; ` +
        "re-read it, decide what the merged text should be, and send it again with the new expectation.",
    );
    this.name = "ConflictError";
  }
}

export class GrimoireError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GrimoireError";
  }
}

export type ClientOptions = {
  baseUrl: string;
  token: string;
  /** Optional: a token is already pinned to its project, so this is only ever belt and braces. */
  projectId?: string;
};

export class GrimoireClient {
  private readonly baseUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.token}`);
    if (this.options.projectId) headers.set("x-grimoire-project", this.options.projectId);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new GrimoireError(0, `Could not reach Grimoire at ${this.baseUrl}: ${(cause as Error).message}`);
    }

    const text = await response.text();
    const body = text ? safeParse(text) : null;

    if (response.status === 409 && isConflict(body)) {
      // Surfaced rather than retried: retrying a compare-and-swap is last-writer-wins with
      // extra steps, and would quietly defeat the protection a person is relying on.
      throw new ConflictError(body.field, body.current);
    }
    if (!response.ok) {
      let message = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Grimoire returned ${response.status}`;
      // Validation refusals carry field-level issues; dropping them would leave the agent
      // with a bare "Invalid request" and nothing to correct.
      const details = typeof body === "object" && body !== null && "details" in body
        ? (body as { details: unknown }).details
        : null;
      if (Array.isArray(details) && details.length > 0) {
        const issues = details
          .map((issue) => {
            const at = Array.isArray((issue as { path?: unknown }).path)
              ? ((issue as { path: unknown[] }).path.join(".") || "request")
              : "request";
            return `- ${at}: ${String((issue as { message?: unknown }).message ?? "invalid")}`;
          })
          .join("\n");
        message = `${message}\n${issues}`;
      }
      throw new GrimoireError(response.status, message);
    }
    return body as T;
  }

  /** Who this credential is, including its scope, so the server can shape its tool surface. */
  session(): Promise<{ status: string; agent?: { name: string; scope: "read" | "write" } }> {
    return this.request("/api/session");
  }

  board(): Promise<Board> {
    return this.request<Board>("/api/board");
  }

  /** One page, without dragging the whole board across to read a single title. */
  page(id: string): Promise<{ page: Page }> {
    return this.request<{ page: Page }>(`/api/pages/${encodeURIComponent(id)}`);
  }

  /**
   * The conversation on a page, which is where an agent reports and is answered.
   *
   * Separate from the page itself on purpose: notes are the brief and belong to whoever wrote
   * them, and an agent rewriting them to say what it did would destroy the thing it was asked
   * to work from.
   */
  discussion(pageId: string): Promise<{ threads: DiscussionThread[] }> {
    return this.request<{ threads: DiscussionThread[] }>(`/api/pages/${encodeURIComponent(pageId)}/discussion`);
  }

  openThread(pageId: string, body: string): Promise<{ thread: DiscussionThread }> {
    return this.request<{ thread: DiscussionThread }>(`/api/pages/${encodeURIComponent(pageId)}/discussion`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  replyToThread(pageId: string, threadId: string, body: string): Promise<{ thread: DiscussionThread }> {
    return this.request<{ thread: DiscussionThread }>(
      `/api/pages/${encodeURIComponent(pageId)}/discussion/${encodeURIComponent(threadId)}/replies`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }

  search(query: string, limit?: number): Promise<SearchResults> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request<SearchResults>(`/api/search?${params}`);
  }

  createPage(body: Record<string, unknown>): Promise<{ page: Page }> {
    return this.request<{ page: Page }>("/api/pages", { method: "POST", body: JSON.stringify(body) });
  }

  updatePage(id: string, body: Record<string, unknown>): Promise<{ page: Page }> {
    return this.request<{ page: Page }>(`/api/pages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  ideas(): Promise<{ ideas: Idea[] }> {
    return this.request<{ ideas: Idea[] }>("/api/ideas");
  }

  createIdea(body: Record<string, unknown>): Promise<{ idea: Idea }> {
    return this.request<{ idea: Idea }>("/api/ideas", { method: "POST", body: JSON.stringify(body) });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isConflict(body: unknown): body is { field: string; current: unknown } {
  return typeof body === "object" && body !== null && "conflict" in body && "field" in body;
}
