/*
 * What an agent credential may reach: an allow list, applied before any route runs.
 *
 * A route added later is closed to agents until someone decides otherwise. Forgetting to
 * open a route is a bug report; forgetting to close one would be a hole.
 */

export const AGENT_PAGE_PATH = /^\/api\/pages\/[^/]+$/;
export const AGENT_IDEA_PATH = /^\/api\/ideas\/[^/]+$/;
export const AGENT_DISCUSSION_PATH = /^\/api\/pages\/[^/]+\/discussion$/;
export const AGENT_REPLY_PATH = /^\/api\/pages\/[^/]+\/discussion\/[^/]+\/replies$/;

/**
 * Whether an agent token may use a route at all, and whether doing so is a write.
 *
 * The rule the list encodes: an agent may add and refine, and only a person may destroy or
 * restructure. So creating and editing pages and ideas is open, while archiving, restoring,
 * promoting an idea, and anything that reshapes the project - chapters, categories, members,
 * invitations, the project itself - is closed no matter how the token is scoped. Archiving
 * is the sharpest of those: its undo is eight seconds long and built for a person who just
 * clicked, so an agent that archived thirty pages would leave no path anyone would find.
 *
 * Account routes are closed because a delegated credential must not be able to escalate into
 * the identity it borrows. The event stream is closed because presence is derived from open
 * streams, and an agent holding one would appear to be a teammate sitting in the project.
 *
 * `null` means refuse. Reads are unmetered; writes are charged against the rate limit.
 */
export function agentMayReach(method: string, pathname: string): "read" | "write" | null {
  if (method === "GET") {
    if (pathname === "/api/health" || pathname === "/api/session") return "read";
    if (pathname === "/api/board" || pathname === "/api/search" || pathname === "/api/ideas") return "read";
    // One page, for an agent that already knows which one it wants. Reading a single page by
    // pulling the whole board is what an agent had to do before, and on a large project that
    // is most of a megabyte to answer a question about one title.
    if (AGENT_PAGE_PATH.test(pathname)) return "read";
    // Reading the discussion is how an agent finds out what it was asked, which is the point
    // of letting it write there at all.
    if (AGENT_DISCUSSION_PATH.test(pathname)) return "read";
    // The activity log is owner-only, and the route enforces that against the person the
    // token acts as. A token therefore never reads more than its issuer already could.
    if (pathname === "/api/activity") return "read";
    return null;
  }
  if (method === "POST" && (pathname === "/api/pages" || pathname === "/api/ideas")) return "write";
  if (method === "PATCH" && (AGENT_PAGE_PATH.test(pathname) || AGENT_IDEA_PATH.test(pathname)))
    return "write";
  /*
   * Opening a thread and replying to one are the two writes an agent is most obviously good
   * for: reporting what it did, and answering when asked. Both are additions to a page that a
   * person can read and argue with, which is exactly the shape of write agents are trusted
   * with everywhere else here.
   *
   * Marking a thread answered is absent by design, and so is anything that would edit or
   * delete what was said. An agent that could close the question it raised could report its
   * own work settled, and the one judgement a discussion carries would stop meaning anything.
   */
  if (method === "POST" && (AGENT_DISCUSSION_PATH.test(pathname) || AGENT_REPLY_PATH.test(pathname)))
    return "write";
  // Marking a conversation read is a claim about a person's attention, and an agent has none.
  return null;
}
