import type {
  AgentToken,
  AgentTokenScope,
  ArchivedProject,
  AuditPage,
  AwayState,
  BoardWorkspace,
  EditConflict,
  IdeaWorkspace,
  SearchResults,
  SessionState,
} from "../../shared/types";

const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let activeProjectId: string | null = new URLSearchParams(globalThis.location?.search ?? "").get("project");

export function setActiveProjectId(id: string | null): void {
  activeProjectId = id;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed error body, so a caller can read a refusal's details without a second request. */
    readonly payload: unknown = null,
  ) {
    super(message);
  }
}

/**
 * A save the server refused because the stored content had already moved on.
 *
 * Distinguished from every other 409 by the `conflict` marker, so an editor can answer
 * it in place while unrelated refusals still reach the global error banner.
 */
export function editConflict<T>(error: unknown): EditConflict<T> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const payload = error.payload as Partial<EditConflict<T>> | null;
  return payload?.conflict === true && payload.current !== undefined ? (payload as EditConflict<T>) : null;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (activeProjectId) headers.set("x-grimoire-project", activeProjectId);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? `Request failed with status ${response.status}`, response.status, body);
  }
  return body;
}

export function session(): Promise<SessionState> {
  return request<SessionState>("/api/session");
}

export function board(): Promise<BoardWorkspace> {
  return request<BoardWorkspace>("/api/board");
}

export function ideas(): Promise<IdeaWorkspace> {
  return request<IdeaWorkspace>("/api/ideas");
}

export function activity(options: { entityId?: string; before?: number; limit?: number } = {}): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (options.entityId) params.set("entity", options.entityId);
  if (options.before !== undefined) params.set("before", String(options.before));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return request<AuditPage>(`/api/activity${params.size ? `?${params}` : ""}`);
}

/** Searches the whole project - every column, the idea garden, and archived pages. */
export function search(query: string, signal?: AbortSignal): Promise<SearchResults> {
  return request<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`, { signal });
}

export function away(): Promise<AwayState> {
  return request<AwayState>("/api/away");
}

export function agentTokens(): Promise<{ tokens: AgentToken[] }> {
  return request<{ tokens: AgentToken[] }>("/api/agent-tokens");
}

/** Asks the server whether its GitHub repository and token actually answer. */
export type GithubVerification =
  | { ok: true; repo: string; private: boolean }
  | { ok: false; reason: string; message: string };

export function verifyGithub(): Promise<GithubVerification> {
  return request<GithubVerification>("/api/github/verify", { method: "POST", body: "{}" });
}

/** The owner's restore list: every project that has been archived, newest first. */
export function archivedProjects(): Promise<{ projects: ArchivedProject[] }> {
  return request<{ projects: ArchivedProject[] }>("/api/projects/archived");
}

/**
 * Whether a credential can still act. The server refuses expired credentials exactly like
 * revoked ones, so listing an expired one as live would show a working revoke button on a
 * thing that already stopped.
 */
export function agentTokenIsLive(token: AgentToken, now = Date.now()): boolean {
  if (token.revokedAt !== null) return false;
  return token.expiresAt === null || Date.parse(token.expiresAt) > now;
}

/**
 * Issues a credential. The secret comes back exactly once and is never readable again,
 * so the caller has to show it before it forgets it.
 */
export function issueAgentToken(input: { name: string; scope: AgentTokenScope }): Promise<{
  token: AgentToken;
  secret: string;
}> {
  return mutate<{ token: AgentToken; secret: string }>("/api/agent-tokens", "POST", input);
}

export function revokeAgentToken(id: string): Promise<{ ok: boolean }> {
  return mutate(`/api/agent-tokens/${id}`, "DELETE");
}

/** Advances the private seen cursor to the newest change; the server clamps and MAX-guards it. */
export function markSeen(): Promise<{ ok: boolean }> {
  return mutate("/api/seen", "POST", {});
}

export function liveEventsUrl(): string {
  const project = activeProjectId ? `&project=${encodeURIComponent(activeProjectId)}` : "";
  return `/api/events?client=${encodeURIComponent(clientId)}${project}`;
}

export function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method,
    body: JSON.stringify(body),
    headers: { "x-grimoire-client-id": clientId },
  });
}

export function uploadImage(file: Blob): Promise<{ name: string }> {
  return request<{ name: string }>("/api/images", {
    method: "POST",
    body: file,
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-grimoire-client-id": clientId,
    },
  });
}

/** Resolves an Obsidian-style embed name to the authenticated image route for the active project. */
export function imageUrl(name: string): string {
  const project = activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : "";
  return `/api/images/${encodeURIComponent(name)}${project}`;
}

export function uploadAvatar(file: Blob): Promise<{ avatarUrl: string }> {
  return request<{ avatarUrl: string }>("/api/account/avatar", {
    method: "PUT",
    body: file,
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-grimoire-client-id": clientId,
    },
  });
}
