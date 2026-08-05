import type { BoardWorkspace, IdeaWorkspace, SessionState } from "../../shared/types";

const clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let activeProjectId: string | null = new URLSearchParams(globalThis.location?.search ?? "").get("project");

export function setActiveProjectId(id: string | null): void {
  activeProjectId = id;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (activeProjectId) headers.set("x-grimoire-project", activeProjectId);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? `Request failed with status ${response.status}`, response.status);
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
