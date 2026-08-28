import { CHAPTER_STATE_LABELS, chapterAction, chapterChanges, chapterCreationChanges } from "../audit";
import { HttpError, json, readJson, requestClientId } from "../http";
import {
  chaptersForProject,
  closeChapter,
  createChapter,
  deleteChapter,
  nextChapterAfter,
  pagesInChapter,
  updateChapter,
} from "../repository/chapters";
import { projectById, projectRecapConfig } from "../repository/projects";
import {
  ALREADY_OPEN_MESSAGE,
  chapterCloseSchema,
  chapterCreateSchema,
  chapterUpdateSchema,
} from "../schemas";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

const chapterPattern = /^\/api\/chapters\/([^/]+)$/;
const chapterClosePattern = /^\/api\/chapters\/([^/]+)\/close$/;

/** The chapters an owner shapes the work into: created, edited, closed, deleted. */
export function chapterRoutes(app: AppContext): Route[] {
  const { database, pageStore, chapterStore } = app;
  return [
    {
      method: "POST",
      pattern: "/api/chapters",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage chapters");
        app.requireChaptersEnabled(projectId);
        const input = chapterCreateSchema.parse(await readJson(context.request));
        const result = createChapter(database, chapterStore, projectId, user.id, input);
        if (!result) throw new HttpError(404, "Project not found");
        if (result === "invalid_name")
          throw new HttpError(400, "The chapter needs a name with letters or numbers");
        if (result === "exists") throw new HttpError(409, "A chapter with this name already exists");
        if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
        app.audit(context, {
          projectId,
          entityType: "chapter",
          entityId: result.chapter.slug,
          entityTitle: result.chapter.name,
          action: "created",
          changes: chapterCreationChanges(result.chapter),
        });
        json(context.response, 201, { chapter: result.chapter });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "PATCH",
      pattern: chapterPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage chapters");
        app.requireChaptersEnabled(projectId);
        const input = chapterUpdateSchema.parse(await readJson(context.request));
        const before = chaptersForProject(database, chapterStore, projectId).find(
          (chapter) => chapter.slug === match![1]!,
        );
        const result = updateChapter(database, chapterStore, projectId, match![1]!, input);
        if (!result) throw new HttpError(404, "Project not found");
        if (result === "not_found") throw new HttpError(404, "Chapter not found");
        if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
        const changes = before ? chapterChanges(before, result.chapter) : [];
        if (changes.length > 0) {
          app.audit(context, {
            projectId,
            entityType: "chapter",
            entityId: result.chapter.slug,
            entityTitle: result.chapter.name,
            action: chapterAction(changes),
            changes,
          });
        }
        json(context.response, 200, { chapter: result.chapter });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: chapterClosePattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage chapters");
        app.requireChaptersEnabled(projectId);
        const input = chapterCloseSchema.parse(await readJson(context.request));
        const slug = match![1]!;
        const project = projectById(database, projectId);
        if (!project) throw new HttpError(404, "Project not found");

        /*
         * "next" is resolved here rather than in the browser so the rollover means the same
         * thing however it was asked for - and so a chapter with nothing planned after it
         * refuses plainly instead of silently setting the work loose.
         */
        let carryTo: string | null | undefined;
        if (input.rollover === "next") {
          carryTo = nextChapterAfter(chapterStore, String(project.slug), slug);
          if (!carryTo) throw new HttpError(400, "There is no planned chapter to roll the work into");
        } else if (input.rollover === "release") carryTo = null;
        else if (input.rollover === "keep") carryTo = undefined;
        else carryTo = input.rollover ?? undefined;

        const before = chapterStore.list(String(project.slug)).find((chapter) => chapter.slug === slug);
        const result = closeChapter(database, pageStore, chapterStore, projectId, slug, carryTo);
        if (result === "not_found") throw new HttpError(404, "Chapter not found");
        if (result === "already_closed") throw new HttpError(409, "That chapter is already closed");
        if (result === "no_target") throw new HttpError(400, "That chapter cannot take the work");

        const carriedWord =
          result.carried.pages === 0
            ? "nothing unfinished"
            : `${result.carried.pages} page${result.carried.pages === 1 ? "" : "s"}${
                result.carried.estimate > 0 ? ` (${result.carried.estimate})` : ""
              }`;
        app.audit(context, {
          projectId,
          entityType: "chapter",
          entityId: slug,
          entityTitle: result.chapter.name,
          action: "updated",
          changes: [
            {
              field: "state",
              from: CHAPTER_STATE_LABELS[before?.state ?? "open"],
              to: CHAPTER_STATE_LABELS.closed,
            },
            {
              field: "carried over",
              from: null,
              to:
                carryTo === undefined || result.carried.pages === 0
                  ? carriedWord
                  : `${carriedWord} to ${carryTo ?? "no chapter"}`,
            },
          ],
        });
        json(context.response, 200, { chapter: result.chapter, carried: result.carried });
        app.broadcast(projectId, "work", requestClientId(context.request));
        /*
         * The recap goes out after the answer, not before it: a Discord outage must never be
         * the reason a chapter fails to close. Whatever happens to the post, the close already
         * happened and the board already knows.
         */
        if (projectRecapConfig(database, projectId).onClose) {
          void app.sendRecap(projectId, slug).catch((error) => console.error("recap post failed", error));
        }
      },
    },
    {
      method: "DELETE",
      pattern: chapterPattern,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage chapters");
        app.requireChaptersEnabled(projectId);
        const removed = chaptersForProject(database, chapterStore, projectId).find(
          (chapter) => chapter.slug === match![1]!,
        );
        const released = pagesInChapter(database, pageStore, projectId, match![1]!);
        if (!deleteChapter(database, pageStore, chapterStore, projectId, match![1]!)) {
          throw new HttpError(404, "Chapter not found");
        }
        app.audit(context, {
          projectId,
          entityType: "chapter",
          entityId: match![1]!,
          entityTitle: removed?.name ?? match![1]!,
          action: "deleted",
          changes: released > 0 ? [{ field: "pages released", from: null, to: String(released) }] : [],
        });
        json(context.response, 200, { ok: true, released });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
