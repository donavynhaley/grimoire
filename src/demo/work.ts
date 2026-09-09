import { z } from "zod";
import { isCalendarDay } from "../../shared/calendar-day";
import {
  discussionAnswerSchema,
  discussionBodySchema,
  ideaSchema,
  ideaUpdateSchema,
  pageSchema,
  pageUpdateSchema,
} from "../../shared/request-schemas";
import type { AuditAction, AuditEntityType, DiscussionMessage, Idea, Page } from "../../shared/types";
import { type DemoProject, type DemoState, demoId, newDemoPage } from "./seed";

export class DemoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function requireDemo<T>(value: T | undefined): T {
  if (value === undefined)
    throw new DemoError("This item is no longer in the demo. Reset the demo to start again.", 404);
  return value;
}
export function recordDemo(
  project: DemoProject,
  state: DemoState,
  now: string,
  entityType: AuditEntityType,
  entityId: string,
  entityTitle: string,
  action: AuditAction,
): void {
  project.events.push({
    sequence: project.events.length + 1,
    id: demoId(state),
    actorId: project.board.currentUser.id,
    actorName: project.board.currentUser.name,
    agentName: null,
    agentTokenId: null,
    entityType,
    entityId,
    entityTitle,
    action,
    changes: [],
    createdAt: now,
  });
}
function checkContent(
  current: Page | Idea,
  input: { expectedTitle?: string; expectedDescription?: string },
): void {
  for (const [field, expected] of [
    ["title", input.expectedTitle],
    ["description", input.expectedDescription],
  ] as const) {
    if (expected !== undefined && expected !== current[field])
      throw new DemoError("This content changed. Review the current version before saving.", 409, {
        conflict: true,
        field,
        current,
      });
  }
}
function validatePage(project: DemoProject, page: Page): void {
  const board = project.board;
  if (!board.project.estimatesEnabled) page.estimate = null;
  if (page.category && !board.categories.some((item) => item.slug === page.category))
    throw new DemoError("Choose an existing category.");
  if (page.chapter && !board.chapters.some((item) => item.slug === page.chapter))
    throw new DemoError("Choose an existing chapter.");
  if (page.assigneeId && !board.members.some((item) => item.id === page.assigneeId))
    throw new DemoError("Choose a project member.");
  page.assigneeName = board.members.find((item) => item.id === page.assigneeId)?.name ?? null;
  const reaches = (id: string, seen = new Set<string>()): boolean => {
    if (id === page.id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return board.pages.find((item) => item.id === id)?.blockedBy.some((next) => reaches(next, seen)) ?? false;
  };
  if (page.blockedBy.some((id) => !board.pages.some((item) => item.id === id) || reaches(id)))
    throw new DemoError("Dependencies must name existing pages and cannot form a cycle.");
  for (const [key, value] of Object.entries(page.fields)) {
    const field = board.fields.find((item) => item.key === key);
    if (!field) throw new DemoError("Choose an existing field.");
    if ((field.type === "select" || field.type === "search-select") && !field.options.includes(String(value)))
      throw new DemoError("Choose one of the field's options.");
    if (field.type === "date" && (typeof value !== "string" || !isCalendarDay(value)))
      throw new DemoError("This field needs a valid calendar day.");
    if ((field.type === "text" || field.type === "date") && typeof value !== "string")
      throw new DemoError("This field needs text.");
    if (field.type === "number" && typeof value !== "number")
      throw new DemoError("This field needs a number.");
    if (field.type === "checkbox" && typeof value !== "boolean")
      throw new DemoError("This field needs a checkbox value.");
  }
}
export function workRequest(
  state: DemoState,
  project: DemoProject,
  path: string[],
  method: string,
  body: unknown,
  now: string,
): unknown {
  const [, , domain, id, action, threadId, threadAction] = path;
  const board = project.board;
  if (domain === "pages") {
    if (!id && method === "POST") {
      const input = pageSchema.strict().parse(body);
      const page = newDemoPage(demoId(state), input.title, now);
      const { fields, ...rest } = input;
      Object.assign(page, rest, { position: board.pages.length });
      for (const [key, value] of Object.entries(fields ?? {})) if (value !== null) page.fields[key] = value;
      if (board.members.length === 1 && input.assigneeId === undefined)
        page.assigneeId = board.currentUser.id;
      validatePage(project, page);
      if (page.status === "done") page.completedAt = now;
      board.pages.push(page);
      recordDemo(project, state, now, "page", page.id, page.title, "created");
      return { page };
    }
    if (id && action === "restore" && method === "POST") {
      const page = requireDemo(project.archivedPages.find((item) => item.id === id));
      project.archivedPages = project.archivedPages.filter((item) => item.id !== id);
      board.pages.push(page);
      recordDemo(project, state, now, "page", id, page.title, "restored");
      return { page };
    }
    const page = requireDemo(board.pages.find((item) => item.id === id));
    if (action === "discussion") {
      project.discussions[page.id] ??= [];
      const threads = requireDemo(project.discussions[page.id]);
      if (method === "GET" && !threadId) return { threads };
      if (threadId === "seen" && method === "POST") return { ok: true };
      if (method === "POST" && (!threadId || threadAction === "replies")) {
        const input = discussionBodySchema.parse(body);
        const message: DiscussionMessage = {
          id: demoId(state),
          authorId: board.currentUser.id,
          authorName: board.currentUser.name,
          agentName: null,
          body: input.body,
          createdAt: now,
          mentions: board.members
            .filter((member) => input.body.includes(`@${member.name}`))
            .map((member) => member.id),
        };
        if (threadId) {
          const thread = requireDemo(threads.find((item) => item.id === threadId));
          thread.replies.push(message);
          recordDemo(project, state, now, "page", page.id, page.title, "replied");
          return { thread };
        }
        const thread = {
          ...message,
          replies: [],
          answeredAt: null,
          answeredById: null,
          answeredByName: null,
        };
        threads.push(thread);
        recordDemo(project, state, now, "page", page.id, page.title, "asked");
        return { thread };
      }
      if (method === "POST" && threadAction === "answered") {
        const { answered } = discussionAnswerSchema.parse(body);
        const thread = requireDemo(threads.find((item) => item.id === threadId));
        Object.assign(thread, {
          answeredAt: answered ? now : null,
          answeredById: answered ? board.currentUser.id : null,
          answeredByName: answered ? board.currentUser.name : null,
        });
        recordDemo(project, state, now, "page", page.id, page.title, answered ? "answered" : "reopened");
        return { thread };
      }
    }
    if (!action && method === "GET") return { page };
    if (!action && method === "DELETE") {
      board.pages = board.pages.filter((item) => item.id !== id);
      project.archivedPages.push(page);
      for (const other of board.pages) other.blockedBy = other.blockedBy.filter((blocker) => blocker !== id);
      recordDemo(project, state, now, "page", page.id, page.title, "archived");
      return { ok: true };
    }
    if (!action && method === "PATCH") {
      const input = pageUpdateSchema.strict().parse(body);
      checkContent(page, input);
      if (input.github)
        throw new DemoError(
          "GitHub links need a connected repository on your own installation. The demo never contacts GitHub.",
        );
      const { fields, github, expectedTitle: _title, expectedDescription: _description, ...rest } = input;
      const previousStatus = page.status;
      Object.assign(page, rest);
      if (github === null) {
        page.github = null;
        page.githubStatus = null;
      }
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === null) delete page.fields[key];
        else page.fields[key] = value;
      }
      validatePage(project, page);
      page.updatedAt = now;
      page.completedAt = page.status === "done" ? (page.completedAt ?? now) : null;
      const reordered = board.pages
        .filter((item) => item.id !== page.id && item.status === page.status)
        .sort((a, b) => a.position - b.position);
      reordered.splice(Math.min(page.position, reordered.length), 0, page);
      reordered.forEach((item, index) => {
        item.position = index;
      });
      recordDemo(
        project,
        state,
        now,
        "page",
        page.id,
        page.title,
        page.status === previousStatus ? "updated" : "moved",
      );
      return { page };
    }
  }
  if (domain === "ideas") {
    if (!id && method === "POST") {
      const input = ideaSchema.strict().parse(body);
      const idea: Idea = {
        id: demoId(state),
        title: input.title,
        description: input.description ?? "",
        state: input.state ?? "inbox",
        position: project.ideas.length,
        createdById: board.currentUser.id,
        createdByName: board.currentUser.name,
        createdAt: now,
        updatedAt: now,
      };
      project.ideas.push(idea);
      recordDemo(project, state, now, "idea", idea.id, idea.title, "created");
      return { idea };
    }
    if (id && action === "promotion" && method === "DELETE") {
      const saved = requireDemo(project.promotions[id]);
      board.pages = board.pages.filter((item) => item.id !== saved.pageId);
      project.ideas.push(saved.idea);
      delete project.promotions[id];
      recordDemo(project, state, now, "idea", id, saved.idea.title, "restored");
      return { idea: saved.idea };
    }
    const idea = requireDemo(project.ideas.find((item) => item.id === id));
    if (!action && method === "PATCH") {
      const input = ideaUpdateSchema.strict().parse(body);
      checkContent(idea, input);
      const { expectedTitle: _title, expectedDescription: _description, ...rest } = input;
      Object.assign(idea, rest, { updatedAt: now });
      recordDemo(project, state, now, "idea", idea.id, idea.title, "updated");
      return { idea };
    }
    if (action === "promote" && method === "POST") {
      const page = newDemoPage(demoId(state), idea.title, now);
      page.description = idea.description;
      board.pages.push(page);
      project.promotions[idea.id] = { idea, pageId: page.id };
      project.ideas = project.ideas.filter((item) => item.id !== idea.id);
      recordDemo(project, state, now, "idea", idea.id, idea.title, "promoted");
      return { page };
    }
  }
  throw new DemoError("This feature needs your own Grimoire installation. No request was sent.", 403);
}
export const demoAssetSchema = z
  .object({
    dataUrl: z
      .string()
      .max(2_800_000)
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();
