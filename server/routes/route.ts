import type { RequestContext } from "../app-types";

/**
 * One route: a method, the pattern its path answers to, and the handler.
 *
 * The table replaces a flat if-chain that had grown to sixty-eight routes. Matching is
 * first-registered-wins, in the order the groups register - the same order the chain
 * read in, so nothing about shadowing changes by accident. What does change is that the
 * table can be walked: hoisted patterns stop being rebuilt per request, and a test can
 * prove a policy holds for every route instead of for a list somebody remembered to
 * extend.
 */
export type Route = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** A literal pathname, or a regex whose capture groups reach the handler as `match`. */
  pattern: string | RegExp;
  handler: (context: RequestContext, match: RegExpMatchArray | null) => Promise<void> | void;
};

export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; match: RegExpMatchArray | null } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === "string") {
      if (route.pattern === pathname) return { route, match: null };
      continue;
    }
    const match = pathname.match(route.pattern);
    if (match) return { route, match };
  }
  return null;
}
