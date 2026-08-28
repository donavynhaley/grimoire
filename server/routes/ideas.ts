import { changeAction, ideaChanges } from "../audit";
import { HttpError, json, readJson, requestClientId } from "../http";
import { createIdea, findIdea, getIdeas, promoteIdea, undoPromotion, updateIdea } from "../ideas-repository";
import { ideaSchema, ideaUpdateSchema } from "../schemas";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

/** The idea garden: the shortlist beside the board, and the promotion path onto it. */
export function ideaRoutes(app: AppContext): Route[] {
  const { database, pageStore, ideaStore, chapterStore } = app;
  return [
    {
      method: "GET",
      pattern: "/api/ideas",
      handler: (context) => {
        const user = requireUser(context);
        const workspace = getIdeas(database, ideaStore, user, app.requireProject(context, user));
        if (!workspace) throw new HttpError(404, "Idea garden not found");
        json(context.response, 200, { ...workspace, currentUser: app.withAvatar(workspace.currentUser) });
      },
    },
    {
      method: "POST",
      pattern: "/api/ideas",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const idea = createIdea(
          database,
          ideaStore,
          projectId,
          user.id,
          ideaSchema.parse(await readJson(context.request)),
        );
        if (!idea) throw new HttpError(404, "Idea garden not found");
        app.audit(context, {
          projectId,
          entityType: "idea",
          entityId: idea.id,
          entityTitle: idea.title,
          action: "created",
        });
        json(context.response, 201, { idea });
        app.broadcast(projectId, "ideas", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/ideas\/([^/]+)\/promote$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        await readJson(context.request);
        const source = findIdea(database, ideaStore, projectId, match![1]!);
        const page = promoteIdea(
          database,
          pageStore,
          chapterStore,
          ideaStore,
          projectId,
          user.id,
          match![1]!,
        );
        if (!page) throw new HttpError(404, "Idea not found");
        app.audit(context, {
          projectId,
          entityType: "idea",
          entityId: match![1]!,
          entityTitle: source?.title ?? page.title,
          action: "promoted",
          changes: [{ field: "became a page", from: null, to: page.title }],
        });
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: page.id,
          entityTitle: page.title,
          action: "created",
          changes: [{ field: "promoted from an idea", from: null, to: source?.title ?? page.title }],
        });
        json(context.response, 201, { page });
        app.broadcast(projectId, "both", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/ideas\/([^/]+)\/promotion$/,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const idea = undoPromotion(database, pageStore, ideaStore, projectId, match![1]!);
        if (!idea) throw new HttpError(404, "Promoted idea not found");
        app.audit(context, {
          projectId,
          entityType: "idea",
          entityId: idea.id,
          entityTitle: idea.title,
          action: "restored",
        });
        json(context.response, 200, { idea });
        app.broadcast(projectId, "both", requestClientId(context.request));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/ideas\/([^/]+)$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const previousIdea = findIdea(database, ideaStore, projectId, match![1]!);
        const idea = updateIdea(
          database,
          ideaStore,
          projectId,
          match![1]!,
          ideaUpdateSchema.parse(await readJson(context.request)),
        );
        if (!idea) throw new HttpError(404, "Idea not found");
        if (previousIdea) {
          const changes = ideaChanges(previousIdea, idea);
          const action = changeAction(changes);
          // Reranking the shortlist changes nothing a reader would look for.
          if (action) {
            app.audit(context, {
              projectId,
              entityType: "idea",
              entityId: idea.id,
              entityTitle: idea.title,
              action,
              changes,
            });
          }
        }
        json(context.response, 200, { idea });
        app.broadcast(projectId, "ideas", requestClientId(context.request));
      },
    },
  ];
}
