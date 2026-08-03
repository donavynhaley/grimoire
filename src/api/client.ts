import type { BoardWorkspace, IdeaWorkspace, SessionState } from "../../shared/types";

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

export function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown = {}): Promise<T> {
  return request<T>(path, { method, body: JSON.stringify(body) });
}
