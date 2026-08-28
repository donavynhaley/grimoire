import type { PageGithubLink } from "../../shared/types";
import { changeAction, pageChanges, pageCreationChanges } from "../audit";
import { parseGithubReference } from "../github";
import { HttpError, json, readJson, requestClientId } from "../http";
import { clearGithubStatus, projectGithubConfig } from "../repository/github";
import { archivePage, createPage, findPage, restorePage, updatePage } from "../repository/pages";
import { pageSchema, pageUpdateSchema } from "../schemas";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

/*
 * Pages register as two groups on purpose: creation and restore go in before the
 * discussion module, and the bare /api/pages/:id record routes go in after it. The
 * discussion patterns (/api/pages/:id/discussion...) are longer than the record
 * pattern, and first-registered-wins matching means they must sit between these two
 * halves - exactly where their blocks sat in the original chain.
 */

export function pageCreateRoutes(app: AppContext): Route[] {
  const { database, pageStore, chapterStore } = app;
  return [
    {
      method: "POST",
      pattern: "/api/pages",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const input = pageSchema.parse(await readJson(context.request));
        if (input.chapter) app.requireChaptersEnabled(projectId);
        const page = createPage(database, pageStore, chapterStore, projectId, user.id, input);
        if (!page) throw new HttpError(400, "Assignee is not a member of this board");
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: page.id,
          entityTitle: page.title,
          action: "created",
          changes: pageCreationChanges(page, app.labelsForProject(projectId)),
        });
        json(context.response, 201, { page });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/restore$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        await readJson(context.request);
        const page = restorePage(database, pageStore, projectId, match![1]!);
        if (!page) throw new HttpError(404, "Archived page not found");
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: page.id,
          entityTitle: page.title,
          action: "restored",
        });
        json(context.response, 200, { page });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}

export function pageRecordRoutes(app: AppContext): Route[] {
  const { database, pageStore, chapterStore } = app;
  return [
    {
      method: "GET",
      pattern: /^\/api\/pages\/([^/]+)$/,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const page = findPage(database, pageStore, projectId, match![1]!);
        // Archived pages answer 404 here rather than being served read-only, because the board
        // has no place to put one and search is the documented way back to the archive.
        if (!page) throw new HttpError(404, "Page not found");
        json(context.response, 200, { page });
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/pages\/([^/]+)$/,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const labels = app.labelsForProject(projectId);
        const before = findPage(database, pageStore, projectId, match![1]!);
        const { github: githubRaw, ...input } = pageUpdateSchema.parse(await readJson(context.request));
        if (input.chapter) app.requireChaptersEnabled(projectId);
        let githubLink: PageGithubLink | null | undefined;
        if (githubRaw !== undefined) {
          if (githubRaw === null) githubLink = null;
          else {
            const parsed = parseGithubReference(githubRaw, projectGithubConfig(database, projectId).repo);
            if (!parsed) {
              throw new HttpError(400, "That does not read as a pull request, a branch, or a GitHub URL");
            }
            githubLink = parsed;
          }
        }
        const page = updatePage(database, pageStore, chapterStore, projectId, match![1]!, {
          ...input,
          ...(githubLink !== undefined ? { github: githubLink } : {}),
        });
        if (!page) throw new HttpError(404, "Page or assignee not found");
        // A dropped link needs no cached answer.
        if (githubLink === null) clearGithubStatus(database, projectId, page.id);
        /*
         * A fresh link is resolved before answering, rather than on the next poll. Someone who
         * just chose a pull request from a list of open ones should not be told "no PR yet"
         * for two minutes while the poller catches up - and since resolving may also move the
         * page, the reply has to be re-read rather than reported from before it happened.
         */
        let settled = page;
        if (githubLink) {
          await app.runGithubSync(projectId);
          settled = findPage(database, pageStore, projectId, page.id) ?? page;
        }
        if (before) {
          // The diff is what this request asked for; a move the automation made on top of it
          // is the automation's to record, under its own name.
          const changes = pageChanges(before, page, labels);
          const action = changeAction(changes);
          // Reordering inside one column changes nothing a reader would look for.
          if (action) {
            app.audit(context, {
              projectId,
              entityType: "page",
              entityId: page.id,
              entityTitle: page.title,
              action,
              changes,
            });
          }
        }
        json(context.response, 200, { page: settled });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/pages\/([^/]+)$/,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const archived = findPage(database, pageStore, projectId, match![1]!);
        if (!archivePage(database, pageStore, projectId, match![1]!)) {
          throw new HttpError(404, "Page not found");
        }
        app.audit(context, {
          projectId,
          entityType: "page",
          entityId: match![1]!,
          entityTitle: archived?.title ?? "a page",
          action: "archived",
        });
        json(context.response, 200, { ok: true });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
