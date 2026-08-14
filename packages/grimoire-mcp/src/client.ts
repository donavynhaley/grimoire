/**
 * A thin HTTP client for one Grimoire project.
 *
 * Everything this server does goes through the same routes a browser uses. It never touches
 * the SQLite file or the Markdown directory, because doing so would skip the audit log, the
 * live broadcast, the dependency checks and the compare-and-swap that make a write safe -
 * and because one process is meant to own a project directory at a time.
 */

export type Page = {
  id: string;
  title: string;
  description: string;
  category: string | null;
  chapter: string | null;
  blockedBy: string[];
  status: string;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type Board = {
  project: { id: string; name: string; chaptersEnabled?: boolean };
  categories: Array<{ slug: string; name: string; color: string }>;
  chapters: Array<{ slug: string; name: string; state: string; description: string }>;
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
      const message = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Grimoire returned ${response.status}`;
      throw new GrimoireError(response.status, message);
    }
    return body as T;
  }

  board(): Promise<Board> {
    return this.request<Board>("/api/board");
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
