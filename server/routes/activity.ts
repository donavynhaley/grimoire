import { AUDIT_PAGE_SIZE, latestAuditSequence, listAuditEvents, listUnseenEvents } from "../audit";
import { HttpError, json, readJson } from "../http";
import { userOwnsProject } from "../repository/projects";
import { advanceSeenCursor, initializeSeenCursor, seenCursor } from "../repository/users";
import { activityQuerySchema, seenSchema } from "../schemas";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

/** The activity log and the reader's private boundary into it. */
export function activityRoutes(app: AppContext): Route[] {
  const { database } = app;
  return [
    {
      method: "GET",
      pattern: "/api/activity",
      handler: (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const query = activityQuerySchema.parse(Object.fromEntries(context.url.searchParams));
        // The project-wide history is the owner's tool; per-entity history stays
        // available to every member because the page dialog shows it inline.
        if (!query.entity && !userOwnsProject(database, user, projectId)) {
          throw new HttpError(403, "Only the project owner can open the project history");
        }
        const page = listAuditEvents(database, projectId, {
          entityId: query.entity,
          before: query.before,
          limit: query.limit ?? AUDIT_PAGE_SIZE,
        });
        json(context.response, 200, page);
      },
    },
    {
      method: "GET",
      pattern: "/api/away",
      handler: (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const latest = latestAuditSequence(database, projectId);
        let since = seenCursor(database, projectId, user.id);
        if (since === null) {
          initializeSeenCursor(database, projectId, user.id, latest);
          since = latest;
        }
        const unseen = listUnseenEvents(database, projectId, { after: since, excludeActorId: user.id });
        json(context.response, 200, { since, latest, total: unseen.total, events: unseen.events });
      },
    },
    {
      method: "POST",
      pattern: "/api/seen",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const input = seenSchema.parse(await readJson(context.request));
        const latest = latestAuditSequence(database, projectId);
        advanceSeenCursor(database, projectId, user.id, Math.min(input.sequence ?? latest, latest));
        json(context.response, 200, { ok: true });
      },
    },
  ];
}
