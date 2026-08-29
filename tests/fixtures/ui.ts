import { cleanup } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, vi } from "vitest";
import type { BoardWorkspace } from "../../shared/types";
import { boardFixture } from "./board";

/**
 * The shared harness for the UI suite (TEST-5). Every file used to carry its own copy of
 * these pieces, and each copy drifted; a test file should hold only what is genuinely its
 * own - the board it stages, the routes it overrides, the writes it reads back.
 */

/** A body answered the way the server would answer it. */
export function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

/** The path a request was aimed at, whichever of fetch's input shapes carried it. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? `${input.pathname}${input.search}` : input.url;
}

/** Unmounts, unstubs, and clears the address bar, so no test inherits another's world. */
export function installUiHarness(): void {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });
}

/** One request as a test reads it back: where it went, how, and what it carried. */
export type RecordedCall = { url: string; method: string; body: unknown };

/**
 * What a route answers with: a JSON body, or a function of the request when the answer
 * depends on what was asked or must carry its own status. A function may return a body,
 * a Response, or a promise of one - which is how a test holds an answer open or refuses it.
 */
export type RouteReply = ((call: RecordedCall) => unknown) | object | string | number | boolean | null;

type RouteFetchOptions = {
  /** The workspace behind every unrouted GET; a function when a test stages its changes. */
  board?: BoardWorkspace | (() => BoardWorkspace);
  /** Keys are `"METHOD /url-prefix"`, or `"/url-prefix"` for any method; checked in order, before the defaults. */
  routes?: Record<string, RouteReply>;
  /** The answer for a write no route claims. */
  write?: RouteReply;
  /** What lands in `calls`: the writes that left the app (the default), or every request. */
  record?: "writes" | "all";
};

/**
 * Stubs fetch with a URL-keyed router, never an ordered queue - a queue breaks unrelated
 * tests the day any component gains a background request (TEST-5). The defaults answer the
 * quiet lookups every mount makes; `routes` answers what the test is actually about, and a
 * reply keyed by the request body is how one URL honestly answers a sequence of writes.
 */
export function routeFetch({
  board = boardFixture(),
  routes = {},
  write = { ok: true },
  record = "writes",
}: RouteFetchOptions = {}): { fetchMock: Mock<typeof fetch>; calls: RecordedCall[] } {
  const workspace = typeof board === "function" ? board : () => board;
  const table = Object.entries(routes).map(([key, reply]) => {
    const space = key.indexOf(" ");
    return space === -1
      ? { method: null, prefix: key, reply }
      : { method: key.slice(0, space), prefix: key.slice(space + 1), reply };
  });

  const answer = (reply: RouteReply, call: RecordedCall): Promise<Response> => {
    const result = typeof reply === "function" ? reply(call) : reply;
    if (result instanceof Response) return Promise.resolve(result);
    if (result instanceof Promise) return result as Promise<Response>;
    return response(result);
  };

  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    const call: RecordedCall = { url, method, body: init.body ? JSON.parse(String(init.body)) : null };
    // Recording is not answering: a write lands in the log whoever replies to it.
    if (method !== "GET" || record === "all") calls.push(call);

    const route = table.find(
      (entry) => (entry.method === null || entry.method === method) && url.startsWith(entry.prefix),
    );
    if (route) return answer(route.reply, call);
    if (method !== "GET") return answer(write, call);
    if (url.startsWith("/api/session"))
      return response({ status: "authenticated", user: workspace().currentUser });
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/projects/archived")) return response({ projects: [] });
    return response(workspace());
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}
