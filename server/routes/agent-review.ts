import type { AgentReview } from "../../shared/types";
import { listAgentTokens } from "../agent-tokens";
import { latestAuditSequence, listAgentEvents, summarize } from "../audit";
import { openAgentThreads } from "../discussion";
import { json, readJson } from "../http";
import { userOwnsProject } from "../repository/projects";
import { advanceAgentReviewCursor, agentReviewCursor } from "../repository/users";
import { seenSchema } from "../schemas";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

/**
 * Everything agents did since this reader last reviewed them, and the boundary they advance.
 *
 * Deliberately absent from the agent allow-list: this is the surface where a person reviews
 * delegated work, and an agent that could read it or advance its cursor could quietly mark
 * its own work looked-at. No agent approves its own work.
 */
export function agentReviewRoutes(app: AppContext): Route[] {
  const { database } = app;
  return [
    {
      method: "GET",
      pattern: "/api/agent-review",
      handler: (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const latest = latestAuditSequence(database, projectId);
        const since = agentReviewCursor(database, projectId, user.id) ?? 0;
        const unseen = listAgentEvents(database, projectId, { after: since });
        const labels = app.labelsForProject(projectId);
        const review: AgentReview = {
          since,
          latest,
          total: unseen.total,
          events: unseen.events,
          waiting: openAgentThreads(database, projectId).map((thread) => ({
            id: thread.id,
            pageId: thread.pageId,
            pageTitle: labels.pageTitle(thread.pageId),
            agentName: thread.agentName,
            agentTokenId: thread.agentTokenId,
            authorId: thread.authorId,
            authorName: thread.authorName,
            body: summarize(thread.body) ?? "",
            createdAt: thread.createdAt,
          })),
        };
        // Credentials travel only to the owner, because revoking one is the owner's act;
        // everyone else still reads the work itself, exactly as the away digest shows it.
        if (userOwnsProject(database, user, projectId)) {
          review.credentials = listAgentTokens(database, projectId);
        }
        json(context.response, 200, review);
      },
    },
    {
      method: "POST",
      pattern: "/api/agent-review/seen",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const input = seenSchema.parse(await readJson(context.request));
        const latest = latestAuditSequence(database, projectId);
        advanceAgentReviewCursor(database, projectId, user.id, Math.min(input.sequence ?? latest, latest));
        json(context.response, 200, { ok: true });
      },
    },
  ];
}
