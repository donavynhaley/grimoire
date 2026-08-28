import { summarize } from "../audit";
import {
  findThread,
  listDiscussion,
  markSeen as markDiscussionSeen,
  openThread,
  parseMentions,
  replyToThread,
  setThreadAnswered,
} from "../discussion";
import { HttpError, json, readJson, requestClientId } from "../http";
import { membersForProject } from "../repository/members";
import { findPage } from "../repository/pages";
import { discussionAnswerSchema, discussionBodySchema } from "../schemas";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

/*
 * The conversation beside a page.
 *
 * Separate from the history on purpose: history is derived and belongs to nobody, while a
 * thread is addressed to somebody and is finished only once it has been answered. Reading
 * is open to every member, exactly as the per-page history is.
 */
export function discussionRoutes(app: AppContext): Route[] {
  const { database, pageStore } = app;
  return [
    {
      method: "GET",
      pattern: /^\/api\/pages\/([^/]+)\/discussion$/,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Page not found");
        json(context.response, 200, { threads: listDiscussion(database, projectId, page.id) });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/discussion$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Page not found");
        const { body } = discussionBodySchema.parse(await readJson(context.request));
        // Resolved here, against the people actually on this project, so a name that belongs to
        // nobody stays plain text rather than becoming a mention of somebody else.
        const thread = openThread(
          database,
          projectId,
          page.id,
          { id: user.id, name: user.name, agentTokenId: context.agent?.tokenId ?? null },
          body,
          parseMentions(body, membersForProject(database, projectId)),
        );
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: page.id,
          entityTitle: page.title,
          action: "asked",
          changes: [{ field: "said", from: null, to: summarize(body) }],
        });
        json(context.response, 201, { thread });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/discussion\/seen$/,
      /*
       * "I have looked at this."
       *
       * Written when somebody opens the column, which is the only moment they can be said to
       * have read it. Private to them, like every other seen marker here: nobody learns how
       * caught up anybody else is.
       */
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Page not found");
        await readJson(context.request);
        markDiscussionSeen(database, projectId, page.id, user.id);
        json(context.response, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/discussion\/([^/]+)\/replies$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Page not found");
        const { body } = discussionBodySchema.parse(await readJson(context.request));
        const thread = replyToThread(
          database,
          projectId,
          page.id,
          match![2]!,
          { id: user.id, name: user.name, agentTokenId: context.agent?.tokenId ?? null },
          body,
          parseMentions(body, membersForProject(database, projectId)),
        );
        if (thread === "no_thread") throw new HttpError(404, "Thread not found");
        if (thread === "answered") {
          throw new HttpError(
            409,
            "That question has been answered. Open a new thread to say something else.",
          );
        }
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: page.id,
          entityTitle: page.title,
          action: "replied",
          changes: [{ field: "said", from: null, to: summarize(body) }],
        });
        json(context.response, 201, { thread });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/discussion\/([^/]+)\/answered$/,
      /*
       * Closing a thread is a judgement that a question has been answered, which is a person's
       * call - agentMayReach refuses this route to every credential, whatever its scope. An
       * agent that could close its own thread could mark its own work reviewed.
       */
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Page not found");
        const { answered } = discussionAnswerSchema.parse(await readJson(context.request));
        const result = setThreadAnswered(database, projectId, page.id, match![2]!, answered, user.id);
        if (result === "no_thread") throw new HttpError(404, "Thread not found");
        // Asking for the state it already holds is a no-op rather than a second log line.
        if (result !== "unchanged") {
          app.audit(context, {
            projectId,
            entityType: "page",
            entityId: page.id,
            entityTitle: page.title,
            action: answered ? "answered" : "reopened",
            changes: [{ field: "question", from: null, to: summarize(result.body) }],
          });
        }
        // The no-op path re-reads the thread, and it can have vanished in the gap;
        // the client's type says thread, so the honest answer to a missing one is 404.
        const thread = result === "unchanged" ? findThread(database, projectId, page.id, match![2]!) : result;
        if (!thread) throw new HttpError(404, "Thread not found");
        json(context.response, 200, { thread });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
