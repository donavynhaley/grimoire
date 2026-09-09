import { z } from "zod";
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  chapterCloseSchema,
  chapterCreateSchema,
  chapterUpdateSchema,
  displayNameSchema,
  fieldCreateSchema,
  fieldUpdateSchema,
  memberRoleSchema,
  projectSchema,
} from "../../shared/request-schemas";
import { type Chapter, fieldTypeSwapAllowed } from "../../shared/types";
import { type DemoProject, type DemoState, demoId, newDemoProject } from "./seed";
import { DemoError, demoAssetSchema, recordDemo, requireDemo } from "./work";

const projectPatch = z
  .object({
    name: projectSchema.shape.name.optional(),
    description: z.string().max(2000).optional(),
    chaptersEnabled: z.boolean().optional(),
    estimatesEnabled: z.boolean().optional(),
    recapOnClose: z.boolean().optional(),
  })
  .strict();
function slug(name: string, existing: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "item";
  let value = base;
  let suffix = 2;
  while (existing.includes(value)) value = `${base}-${suffix++}`;
  return value;
}
export function settingsRequest(
  state: DemoState,
  project: DemoProject,
  path: string[],
  method: string,
  body: unknown,
  now: string,
): unknown {
  const [, , domain, id, action] = path;
  const board = project.board;
  if (domain === "account") {
    if (id === "name" && method === "POST") {
      const { name } = displayNameSchema.strict().parse(body);
      for (const item of state.projects) {
        item.board.currentUser.name = name;
        for (const member of item.board.members) if (member.id === board.currentUser.id) member.name = name;
        for (const page of [...item.board.pages, ...item.archivedPages])
          if (page.assigneeId === board.currentUser.id) page.assigneeName = name;
      }
      return { user: board.currentUser };
    }
    if (id === "avatar" && (method === "PUT" || method === "DELETE")) {
      const avatarUrl = method === "DELETE" ? null : demoAssetSchema.parse(body).dataUrl;
      for (const item of state.projects) {
        item.board.currentUser.avatarUrl = avatarUrl;
        for (const member of item.board.members)
          if (member.id === board.currentUser.id) member.avatarUrl = avatarUrl;
      }
      return { avatarUrl };
    }
  }
  if (domain === "images" && !id && method === "POST") {
    const { dataUrl } = demoAssetSchema.parse(body);
    const name = `${demoId(state)}.png`;
    state.assets[name] = dataUrl;
    return { name };
  }
  if (domain === "projects") {
    if (!id && method === "POST") {
      const { name } = projectSchema.strict().parse(body);
      const created = newDemoProject(demoId(state), name);
      created.board.currentUser = { ...board.currentUser };
      created.board.members = [{ ...board.currentUser, projectRole: "owner" }];
      state.projects.push(created);
      recordDemo(created, state, now, "project", created.board.project.id, name, "created");
      return { project: created.board.project };
    }
    const target = requireDemo(state.projects.find((item) => item.board.project.id === id));
    if (!action && method === "PATCH") {
      const input = projectPatch.parse(body);
      Object.assign(target.board.project, input);
      if (input.estimatesEnabled === false) for (const page of target.board.pages) page.estimate = null;
      recordDemo(target, state, now, "project", id!, target.board.project.name, "updated");
      return { project: target.board.project };
    }
    if (!action && method === "DELETE") {
      if (state.projects.filter((item) => !item.archivedAt).length === 1)
        throw new DemoError("Keep one project open in the demo. Create another before archiving this one.");
      target.archivedAt = now;
      return { ok: true };
    }
    if (action === "restore" && method === "POST") {
      target.archivedAt = null;
      return { project: target.board.project };
    }
  }
  if (domain === "members" && id) {
    const member = requireDemo(board.members.find((item) => item.id === id));
    if (id === board.currentUser.id) throw new DemoError("You remain the owner of this demo project.");
    if (method === "DELETE") {
      board.members = board.members.filter((item) => item.id !== id);
      for (const page of board.pages)
        if (page.assigneeId === id) {
          page.assigneeId = null;
          page.assigneeName = null;
        }
      recordDemo(project, state, now, "member", id, member.name, "removed");
      return { ok: true };
    }
    if (method === "PATCH") {
      member.projectRole = memberRoleSchema.parse(body).role;
      return { member };
    }
  }
  if (domain === "categories") {
    if (!id && method === "POST") {
      const input = categoryCreateSchema.strict().parse(body);
      const category = {
        ...input,
        slug: slug(
          input.name,
          board.categories.map((item) => item.slug),
        ),
        position: board.categories.length,
      };
      board.categories.push(category);
      recordDemo(project, state, now, "category", category.slug, category.name, "created");
      return { category };
    }
    const category = requireDemo(board.categories.find((item) => item.slug === id));
    if (method === "PATCH") {
      Object.assign(category, categoryUpdateSchema.strict().parse(body));
      return { category };
    }
    if (method === "DELETE") {
      board.categories = board.categories.filter((item) => item.slug !== id);
      for (const page of [...board.pages, ...project.archivedPages])
        if (page.category === id) page.category = null;
      return { ok: true };
    }
  }
  if (domain === "fields") {
    if (!id && method === "POST") {
      const input = fieldCreateSchema.strict().parse(body);
      const field = {
        ...input,
        key: slug(
          input.label,
          board.fields.map((item) => item.key),
        ),
        options: input.options ?? [],
        showOnTile: input.showOnTile ?? false,
        position: board.fields.length,
      };
      board.fields.push(field);
      recordDemo(project, state, now, "field", field.key, field.label, "created");
      return { field };
    }
    const field = requireDemo(board.fields.find((item) => item.key === id));
    if (method === "PATCH") {
      const input = fieldUpdateSchema.strict().parse(body);
      if (input.type && !fieldTypeSwapAllowed(field.type, input.type))
        throw new DemoError("This field's type cannot change after creation.");
      if (
        input.options &&
        [...board.pages, ...project.archivedPages].some(
          (page) =>
            page.fields[field.key] !== undefined && !input.options!.includes(String(page.fields[field.key])),
        )
      )
        throw new DemoError("An existing page still uses an option you removed.");
      Object.assign(field, input);
      return { field };
    }
    if (method === "DELETE") {
      board.fields = board.fields.filter((item) => item.key !== id);
      for (const page of [...board.pages, ...project.archivedPages]) delete page.fields[field.key];
      return { ok: true };
    }
  }
  if (domain === "chapters") {
    if (!id && method === "POST") {
      const input = chapterCreateSchema.strict().parse(body);
      if (input.state === "open" && board.chapters.some((item) => item.state === "open"))
        throw new DemoError("Another chapter is already open. Close it before opening this one.", 409);
      const chapter: Chapter = {
        slug: slug(
          input.name,
          board.chapters.map((item) => item.slug),
        ),
        name: input.name,
        description: input.description ?? "",
        state: input.state ?? "planned",
        startsOn: input.startsOn ?? null,
        endsOn: input.endsOn ?? null,
        position: board.chapters.length,
        createdById: board.currentUser.id,
        createdByName: board.currentUser.name,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        carriedPages: null,
        carriedEstimate: null,
        carriedTo: null,
        deliveredPages: null,
        deliveredEstimate: null,
      };
      board.chapters.push(chapter);
      recordDemo(project, state, now, "chapter", chapter.slug, chapter.name, "created");
      return { chapter };
    }
    const chapter = requireDemo(board.chapters.find((item) => item.slug === id));
    if (!action && method === "PATCH") {
      const input = chapterUpdateSchema.strict().parse(body);
      if (input.state === "open" && board.chapters.some((item) => item.slug !== id && item.state === "open"))
        throw new DemoError("Another chapter is already open. Close it before opening this one.", 409);
      if (input.expectedDescription !== undefined && input.expectedDescription !== chapter.description)
        throw new DemoError("This chapter changed. Reopen it before saving.", 409);
      const { expectedDescription: _description, ...rest } = input;
      Object.assign(chapter, rest, { updatedAt: now });
      return { chapter };
    }
    if (action === "close" && method === "POST") {
      const { rollover = "keep" } = chapterCloseSchema.strict().parse(body);
      let destination: string | null = rollover === "keep" ? chapter.slug : null;
      if (rollover === "next")
        destination = requireDemo(
          board.chapters
            .filter((item) => item.state === "planned" && item.slug !== id)
            .sort((a, b) => a.position - b.position)[0],
        ).slug;
      else if (!["keep", "release"].includes(rollover))
        destination = requireDemo(
          board.chapters.find(
            (item) => item.slug === rollover && item.state !== "closed" && item.slug !== id,
          ),
        ).slug;
      const pages = board.pages.filter((page) => page.chapter === id);
      const delivered = pages.filter((page) => page.status === "done");
      const unfinished = pages.filter((page) => page.status !== "done");
      Object.assign(chapter, {
        state: "closed",
        closedAt: now,
        updatedAt: now,
        deliveredPages: delivered.length,
        deliveredEstimate: delivered.reduce((n, p) => n + (p.estimate ?? 0), 0),
        carriedPages: unfinished.length,
        carriedEstimate: unfinished.reduce((n, p) => n + (p.estimate ?? 0), 0),
        carriedTo: destination === id ? null : destination,
      });
      for (const page of unfinished) page.chapter = destination;
      recordDemo(project, state, now, "chapter", chapter.slug, chapter.name, "updated");
      return { chapter };
    }
    if (!action && method === "DELETE") {
      board.chapters = board.chapters.filter((item) => item.slug !== id);
      for (const page of [...board.pages, ...project.archivedPages])
        if (page.chapter === id) page.chapter = null;
      return { ok: true };
    }
  }
  throw new DemoError("This feature needs your own Grimoire installation. Nothing was sent or changed.", 403);
}
