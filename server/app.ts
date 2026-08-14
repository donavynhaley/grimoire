import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { z, ZodError } from "zod";
import type { User } from "../shared/types";
import { createProject, createWizardSimulatorProject, openDatabase } from "./database";
import {
  archivePage,
  archiveProject,
  PageDependencyError,
  pagesInChapter,
  categoriesForProject,
  chaptersEnabled,
  chaptersForProject,
  createPage,
  createCategory,
  createChapter,
  defaultProjectIdForUser,
  deleteCategory,
  deleteChapter,
  EditConflictError,
  findPage,
  findUserByEmail,
  findUserById,
  getBoard,
  listPages,
  listProjectsForUser,
  advanceSeenCursor,
  initializeSeenCursor,
  membersForProject,
  projectById,
  projectSlug,
  publicUser,
  seenCursor,
  removeProjectMember,
  renameProject,
  restorePage,
  setChaptersEnabled,
  updatePage,
  updateCategory,
  updateChapter,
  userCanAccessProject,
  userCount,
} from "./repository";
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from "./security";
import { AVATAR_SIZE_LIMIT, AvatarStore, sniffAvatarType } from "./avatars";
import { IMAGE_SIZE_LIMIT, ProjectImageStore, sniffImageType } from "./project-images";
import { MarkdownPageStore } from "./markdown-pages";
import { isCalendarDay, MarkdownChapterStore } from "./markdown-chapters";
import { createIdea, findIdea, getIdeas, promoteIdea, undoPromotion, updateIdea } from "./ideas-repository";
import { MarkdownIdeaStore } from "./markdown-ideas";
import { searchProject } from "./search";
import { applyLinkPreview, pagePreview, ideaPreview, type LinkPreview } from "./link-preview";
import {
  AUDIT_PAGE_SIZE,
  pageChanges,
  pageCreationChanges,
  changeAction,
  chapterAction,
  chapterChanges,
  chapterCreationChanges,
  ideaChanges,
  latestAuditSequence,
  listAuditEvents,
  listUnseenEvents,
  recordAuditEvent,
  type PageLabels,
  type RecordAuditInput,
} from "./audit";

const SESSION_COOKIE = "grimoire_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

type Options = {
  pagesDirectory?: string;
  databasePath: string;
  production: boolean;
  staticDirectory?: string;
};

type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  user: User | null;
  sessionToken: string | null;
};

type WorkspaceScope = "work" | "ideas" | "both";

type EventClient = {
  clientId: string;
  projectId: string;
  response: ServerResponse;
  keepAlive: ReturnType<typeof setInterval>;
  userId: string;
};

const accountSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});

const registerSchema = accountSchema.extend({
  inviteCode: z.string().min(20).max(200),
});

const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((input) => input.currentPassword !== input.newPassword, {
    message: "New password must be different from the current password",
    path: ["newPassword"],
  });

const displayNameSchema = accountSchema.pick({ name: true });

const pageStatus = z.enum(["backlog", "ready", "in_progress", "review", "done"]);
const categorySlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40);
const chapterSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60);
const calendarDay = z.string().refine(isCalendarDay, "Expected a YYYY-MM-DD day");
const pageSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  category: categorySlug.nullable().optional(),
  chapter: chapterSlug.nullable().optional(),
  blockedBy: z.array(z.string().uuid()).max(20).optional(),
  status: pageStatus.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
/**
 * Compare-and-swap fields, sent only for the content a client is actually rewriting.
 * A save that omits them keeps the previous last-writer-wins behaviour, which is what
 * ordering and column moves want - a drag has no content to lose.
 */
const contentPreconditions = {
  expectedTitle: z.string().trim().max(240).optional(),
  expectedDescription: z.string().trim().max(20_000).optional(),
};
const pageUpdateSchema = pageSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});
const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
});
const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    chaptersEnabled: z.boolean().optional(),
  })
  .refine((input) => input.name !== undefined || input.chaptersEnabled !== undefined, {
    message: "Nothing to update",
  });
const chapterState = z.enum(["planned", "open", "closed"]);
const chapterCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(20_000).optional(),
  startsOn: calendarDay.nullable().optional(),
  endsOn: calendarDay.nullable().optional(),
  state: chapterState.optional(),
});
const chapterUpdateSchema = chapterCreateSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  expectedDescription: z.string().trim().max(20_000).optional(),
});
const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(32),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
const categoryUpdateSchema = categoryCreateSchema.partial();
const ideaState = z.enum(["inbox", "shortlist", "parked"]);
const ideaSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  state: ideaState.optional(),
});
const ideaUpdateSchema = ideaSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(240),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * One chapter is open at a time, so the second one has to be an explicit decision.
 * The interface turns this into a single confirm that closes the current chapter first.
 */
const ALREADY_OPEN_MESSAGE = "Another chapter is already open. Close it before opening this one.";

/** Omitting the sequence means "advance to whatever is newest right now". */
const seenSchema = z.object({ sequence: z.number().int().min(0).optional() }).strict();

export function createGrimoireServer(options: Options) {
  const database = openDatabase(options.databasePath);
  const pageStore = new MarkdownPageStore(options.pagesDirectory ?? join(dirname(options.databasePath), "pages"));
  const ideaStore = new MarkdownIdeaStore(pageStore.rootDirectory);
  const chapterStore = new MarkdownChapterStore(pageStore.rootDirectory);
  const imageStore = new ProjectImageStore(pageStore.rootDirectory);
  const avatarStore = new AvatarStore(join(dirname(options.databasePath), "avatars"));
  // Every project's `cards/` directory becomes `pages/` before anything reads one. This runs
  // ahead of the legacy SQLite migration so both end up writing to the same place.
  for (const project of database.prepare("SELECT slug FROM projects").all() as Array<{ slug: string }>) {
    if (pageStore.migrateLegacyDirectory(String(project.slug))) {
      console.log(`grimoire renamed ${project.slug}/cards to ${project.slug}/pages`);
    }
  }
  pageStore.migrateLegacyPages(database);
  let databaseClosed = false;
  const eventClients = new Set<EventClient>();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof ZodError) {
        json(response, 400, { error: "Invalid request", details: error.issues });
        return;
      }
      if (error instanceof EditConflictError) {
        // The stored record travels with the refusal so the editor can show the
        // collision without asking for it again.
        json(response, 409, { error: error.message, conflict: true, field: error.field, current: error.current });
        return;
      }
      if (error instanceof PageDependencyError) {
        json(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.message });
        return;
      }
      console.error(error);
      json(response, 500, { error: "Internal server error" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const sessionToken = readCookie(request, SESSION_COOKIE);
    const user = sessionToken ? userForSession(sessionToken) : null;
    const context: RequestContext = { request, response, url, user, sessionToken };

    if (url.pathname.startsWith("/api/")) {
      await handleApi(context);
      return;
    }
    if (options.production && options.staticDirectory) {
      const filePath = resolveStaticPath(url.pathname, options.staticDirectory);
      if (!filePath) {
        json(response, 404, { error: "Application build not found" });
        return;
      }
      if (extname(filePath) === ".html") serveDocument(response, filePath, linkPreviewFor(url));
      else serveFile(response, filePath);
      return;
    }
    json(response, 404, { error: "Not found" });
  }

  async function handleApi(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    const method = request.method ?? "GET";

    // A browser that loaded the previous bundle keeps asking for /api/cards until it is
    // reloaded, and a deploy should not turn someone's in-flight save into a 404. The alias
    // can be deleted once every open tab has certainly been reloaded.
    if (url.pathname === "/api/cards" || url.pathname.startsWith("/api/cards/")) {
      url.pathname = `/api/pages${url.pathname.slice("/api/cards".length)}`;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/session") {
      if (userCount(database) === 0) json(response, 200, { status: "setup_required" });
      else if (!context.user) json(response, 200, { status: "anonymous" });
      else json(response, 200, { status: "authenticated", user: withAvatar(context.user) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/bootstrap") {
      if (userCount(database) !== 0) throw new HttpError(409, "Setup is already complete");
      const input = accountSchema.parse(await readJson(request));
      if (userCount(database) !== 0) throw new HttpError(409, "Setup is already complete");
      const userId = randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(input.password);
      database
        .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)")
        .run(userId, input.name, input.email, passwordHash, now);
      let projectId: string;
      try {
        projectId = createWizardSimulatorProject(database, userId);
      } catch (error) {
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        throw error;
      }
      const user = withAvatar(publicUser(findUserById(database, userId)!));
      audit(user, { projectId, entityType: "project", entityId: projectId, entityTitle: "Wizard Simulator", action: "created" });
      audit(user, { projectId, entityType: "member", entityId: userId, entityTitle: user.name, action: "joined" });
      setSession(response, userId);
      json(response, 201, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/login") {
      const input = loginSchema.parse(await readJson(request));
      const stored = findUserByEmail(database, input.email);
      const passwordMatches = stored
        ? await verifyPassword(input.password, String(stored.password_hash))
        : await verifyPassword(input.password, await hashPassword("invalid password placeholder"));
      const projectId = stored ? defaultProjectIdForUser(database, publicUser(stored)) : null;
      if (!stored || !passwordMatches || !projectId) throw new HttpError(401, "Email or password is incorrect");
      const user = withAvatar(publicUser(stored));
      setSession(response, user.id);
      json(response, 200, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/logout") {
      if (context.sessionToken) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(context.sessionToken));
      clearSession(response);
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/account/password") {
      const user = requireUser(context);
      const input = passwordChangeSchema.parse(await readJson(request));
      const stored = findUserById(database, user.id)!;
      if (!(await verifyPassword(input.currentPassword, String(stored.password_hash)))) {
        throw new HttpError(401, "Current password is incorrect");
      }
      const passwordHash = await hashPassword(input.newPassword);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
        if (context.sessionToken) {
          database
            .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
            .run(user.id, hashToken(context.sessionToken));
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/account/name") {
      const user = requireUser(context);
      const input = displayNameSchema.parse(await readJson(request));
      database.prepare("UPDATE users SET name = ? WHERE id = ?").run(input.name, user.id);
      const updated = withAvatar(publicUser(findUserById(database, user.id)!));
      json(response, 200, { user: updated });
      // Names are joined in at read time, so every card byline, idea, and member face is stale.
      broadcast(requireProject(context, user), "both", requestClientId(request));
      return;
    }

    if (method === "PUT" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      const data = await readRaw(request, AVATAR_SIZE_LIMIT);
      const imageType = sniffAvatarType(data);
      if (!imageType) throw new HttpError(400, "Profile picture must be a PNG, JPEG, or WebP image");
      avatarStore.save(user.id, data, imageType);
      json(response, 200, { avatarUrl: avatarStore.urlFor(user.id) });
      broadcast(requireProject(context, user), "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      avatarStore.remove(user.id);
      json(response, 200, { ok: true });
      broadcast(requireProject(context, user), "work", requestClientId(request));
      return;
    }

    const avatarMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)$/);
    if (method === "GET" && avatarMatch) {
      requireUser(context);
      if (!/^[0-9a-f-]{36}$/i.test(avatarMatch[1])) throw new HttpError(404, "Profile picture not found");
      const avatar = avatarStore.get(avatarMatch[1]);
      if (!avatar) throw new HttpError(404, "Profile picture not found");
      response.statusCode = 200;
      response.setHeader("Content-Type", avatar.contentType);
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      createReadStream(avatar.path).pipe(response);
      return;
    }

    if (method === "POST" && url.pathname === "/api/images") {
      const user = requireUser(context);
      const slug = projectSlug(database, requireProject(context, user));
      if (!slug) throw new HttpError(404, "Board not found");
      const data = await readRaw(request, IMAGE_SIZE_LIMIT);
      const imageType = sniffImageType(data);
      if (!imageType) throw new HttpError(400, "Notes images must be a PNG, JPEG, WebP, or GIF image");
      const name = imageStore.save(slug, data, imageType);
      json(response, 201, { name });
      return;
    }

    const imageMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
    if (method === "GET" && imageMatch) {
      const user = requireUser(context);
      const slug = projectSlug(database, requireProject(context, user));
      let imageName: string;
      try {
        imageName = decodeURIComponent(imageMatch[1]);
      } catch {
        throw new HttpError(404, "Image not found");
      }
      const image = slug ? imageStore.get(slug, imageName) : null;
      if (!image) throw new HttpError(404, "Image not found");
      response.statusCode = 200;
      response.setHeader("Content-Type", image.contentType);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      createReadStream(image.path).pipe(response);
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/register") {
      const input = registerSchema.parse(await readJson(request));
      const invite = database.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hashToken(input.inviteCode)) as
        | Record<string, string | null>
        | undefined;
      if (!invite || invite.used_by || String(invite.expires_at) <= new Date().toISOString()) {
        throw new HttpError(409, "Invitation is invalid or has already been used");
      }
      if (findUserByEmail(database, input.email)) throw new HttpError(409, "An account already uses this email");
      const invitedProject = invite.project_id
        ? database.prepare("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL").get(String(invite.project_id))
        : undefined;
      if (!invitedProject) throw new HttpError(409, "Invitation project no longer exists");
      const projectId = String(invite.project_id);
      const userId = randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(input.password);

      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)")
          .run(userId, input.name, input.email, passwordHash, now);
        database
          .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
          .run(projectId, userId, now);
        const update = database
          .prepare("UPDATE invites SET used_by = ? WHERE id = ? AND used_by IS NULL")
          .run(userId, String(invite.id));
        if (Number(update.changes) !== 1) throw new HttpError(409, "Invitation has already been used");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const user = withAvatar(publicUser(findUserById(database, userId)!));
      audit(user, { projectId, entityType: "member", entityId: userId, entityTitle: user.name, action: "joined" });
      setSession(response, userId);
      json(response, 201, { user });
      broadcast(projectId, "work", null);
      return;
    }

    if (method === "POST" && url.pathname === "/api/invites") {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the project owner can create invitations");
      const projectId = requireProject(context, user);
      await readJson(request);
      const code = createOpaqueToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare("DELETE FROM invites WHERE created_by = ? AND project_id = ? AND used_by IS NULL")
          .run(user.id, projectId);
        database
          .prepare(
            "INSERT INTO invites (id, code_hash, created_by, project_id, expires_at, used_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
          )
          .run(randomUUID(), hashToken(code), user.id, projectId, expires.toISOString(), now.toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      audit(user, { projectId, entityType: "member", entityId: null, entityTitle: "invitation link", action: "invited" });
      json(response, 201, { code, expiresAt: expires.toISOString() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/projects") {
      const user = requireUser(context);
      json(response, 200, { projects: listProjectsForUser(database, user) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/projects") {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can create projects");
      const input = projectSchema.parse(await readJson(request));
      const projectId = createProject(database, user.id, input.name);
      audit(user, { projectId, entityType: "project", entityId: projectId, entityTitle: input.name, action: "created" });
      json(response, 201, { project: { id: projectId, name: input.name } });
      return;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "PATCH" && projectMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can change project settings");
      const input = projectUpdateSchema.parse(await readJson(request));
      const projectId = projectMatch[1];
      const before = projectById(database, projectId);
      if (!before) throw new HttpError(404, "Project not found");
      const previousName = String(before.name);
      const changes: Array<{ field: string; from: string | null; to: string | null }> = [];

      if (input.name !== undefined && input.name !== previousName) {
        if (!renameProject(database, projectId, input.name)) throw new HttpError(404, "Project not found");
        changes.push({ field: "name", from: previousName, to: input.name });
      }
      if (input.chaptersEnabled !== undefined) {
        const wasEnabled = chaptersEnabled(database, projectId);
        if (wasEnabled !== input.chaptersEnabled) {
          if (!setChaptersEnabled(database, projectId, input.chaptersEnabled)) {
            throw new HttpError(404, "Project not found");
          }
          changes.push({
            field: "chapters",
            from: wasEnabled ? "on" : "off",
            to: input.chaptersEnabled ? "on" : "off",
          });
        }
      }

      const name = input.name ?? previousName;
      if (changes.length > 0) {
        audit(user, {
          projectId,
          entityType: "project",
          entityId: projectId,
          entityTitle: name,
          action: changes.some((change) => change.field === "name") ? "renamed" : "updated",
          changes,
        });
      }
      json(response, 200, {
        project: { id: projectId, name, chaptersEnabled: chaptersEnabled(database, projectId) },
      });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && projectMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can archive projects");
      await readJson(request);
      const archivedName = projectById(database, projectMatch[1])?.name;
      const result = archiveProject(database, projectMatch[1]);
      if (result === "not_found") throw new HttpError(404, "Project not found");
      if (result === "last_project") throw new HttpError(409, "The last project cannot be archived");
      audit(user, {
        projectId: projectMatch[1],
        entityType: "project",
        entityId: projectMatch[1],
        entityTitle: String(archivedName ?? "project"),
        action: "archived",
      });
      json(response, 200, { ok: true });
      broadcast(projectMatch[1], "work", requestClientId(request));
      return;
    }

    if (method === "POST" && url.pathname === "/api/categories") {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage categories");
      const projectId = requireProject(context, user);
      const input = categoryCreateSchema.parse(await readJson(request));
      const result = createCategory(database, projectId, input);
      if (result === "invalid_name") throw new HttpError(400, "The category needs a name with letters or numbers");
      if (result === "exists") throw new HttpError(409, "A category with this name already exists");
      audit(user, {
        projectId,
        entityType: "category",
        entityId: result.category.slug,
        entityTitle: result.category.name,
        action: "created",
      });
      json(response, 201, { category: result.category });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const categoryMatch = url.pathname.match(/^\/api\/categories\/([^/]+)$/);
    if (method === "PATCH" && categoryMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage categories");
      const projectId = requireProject(context, user);
      const input = categoryUpdateSchema.parse(await readJson(request));
      const previous = categoriesForProject(database, projectId).find((value) => value.slug === categoryMatch[1]);
      const category = updateCategory(database, projectId, categoryMatch[1], input);
      if (!category) throw new HttpError(404, "Category not found");
      const categoryEdits = previous
        ? [
          ...(previous.name === category.name ? [] : [{ field: "name", from: previous.name, to: category.name }]),
          ...(previous.color === category.color ? [] : [{ field: "color", from: previous.color, to: category.color }]),
        ]
        : [];
      if (categoryEdits.length > 0) {
        audit(user, {
          projectId,
          entityType: "category",
          entityId: category.slug,
          entityTitle: category.name,
          action: "updated",
          changes: categoryEdits,
        });
      }
      json(response, 200, { category });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && categoryMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage categories");
      const projectId = requireProject(context, user);
      const removed = categoriesForProject(database, projectId).find((value) => value.slug === categoryMatch[1]);
      if (!deleteCategory(database, pageStore, projectId, categoryMatch[1])) {
        throw new HttpError(404, "Category not found");
      }
      audit(user, {
        projectId,
        entityType: "category",
        entityId: categoryMatch[1],
        entityTitle: removed?.name ?? categoryMatch[1],
        action: "deleted",
      });
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "POST" && url.pathname === "/api/chapters") {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage chapters");
      const projectId = requireProject(context, user);
      requireChaptersEnabled(projectId);
      const input = chapterCreateSchema.parse(await readJson(request));
      const result = createChapter(database, chapterStore, projectId, user.id, input);
      if (!result) throw new HttpError(404, "Project not found");
      if (result === "invalid_name") throw new HttpError(400, "The chapter needs a name with letters or numbers");
      if (result === "exists") throw new HttpError(409, "A chapter with this name already exists");
      if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
      audit(user, {
        projectId,
        entityType: "chapter",
        entityId: result.chapter.slug,
        entityTitle: result.chapter.name,
        action: "created",
        changes: chapterCreationChanges(result.chapter),
      });
      json(response, 201, { chapter: result.chapter });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const chapterMatch = url.pathname.match(/^\/api\/chapters\/([^/]+)$/);
    if (method === "PATCH" && chapterMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage chapters");
      const projectId = requireProject(context, user);
      requireChaptersEnabled(projectId);
      const input = chapterUpdateSchema.parse(await readJson(request));
      const before = chaptersForProject(database, chapterStore, projectId)
        .find((chapter) => chapter.slug === chapterMatch[1]);
      const result = updateChapter(database, chapterStore, projectId, chapterMatch[1], input);
      if (!result) throw new HttpError(404, "Project not found");
      if (result === "not_found") throw new HttpError(404, "Chapter not found");
      if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
      const changes = before ? chapterChanges(before, result.chapter) : [];
      if (changes.length > 0) {
        audit(user, {
          projectId,
          entityType: "chapter",
          entityId: result.chapter.slug,
          entityTitle: result.chapter.name,
          action: chapterAction(changes),
          changes,
        });
      }
      json(response, 200, { chapter: result.chapter });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && chapterMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the owner can manage chapters");
      const projectId = requireProject(context, user);
      requireChaptersEnabled(projectId);
      const removed = chaptersForProject(database, chapterStore, projectId)
        .find((chapter) => chapter.slug === chapterMatch[1]);
      const released = pagesInChapter(database, pageStore, projectId, chapterMatch[1]);
      if (!deleteChapter(database, pageStore, chapterStore, projectId, chapterMatch[1])) {
        throw new HttpError(404, "Chapter not found");
      }
      audit(user, {
        projectId,
        entityType: "chapter",
        entityId: chapterMatch[1],
        entityTitle: removed?.name ?? chapterMatch[1],
        action: "deleted",
        changes: released > 0 ? [{ field: "pages released", from: null, to: String(released) }] : [],
      });
      json(response, 200, { ok: true, released });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
    if (method === "DELETE" && memberMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the project owner can remove members");
      await readJson(request);
      const projectId = requireProject(context, user);
      const removedMember = membersForProject(database, projectId).find((value) => value.id === memberMatch[1]);
      const result = removeProjectMember(database, pageStore, projectId, memberMatch[1]);
      if (result === "owner") throw new HttpError(409, "The project owner cannot be removed");
      if (result === "not_found") throw new HttpError(404, "Member not found");
      audit(user, {
        projectId,
        entityType: "member",
        entityId: memberMatch[1],
        entityTitle: removedMember?.name ?? "a member",
        action: "removed",
      });
      disconnectUserEvents(memberMatch[1]);
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const clientId = url.searchParams.get("client")?.slice(0, 100) ?? "";
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      response.write(": connected\n\n");
      const client: EventClient = {
        clientId,
        projectId,
        response,
        keepAlive: setInterval(() => response.write(": keepalive\n\n"), 25_000),
        userId: user.id,
      };
      eventClients.add(client);
      broadcastPresence(projectId);
      const remove = () => {
        clearInterval(client.keepAlive);
        eventClients.delete(client);
        broadcastPresence(projectId);
      };
      response.once("close", remove);
      return;
    }

    if (method === "GET" && url.pathname === "/api/activity") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const entity = url.searchParams.get("entity");
      if (entity && !/^[0-9a-z-]{1,64}$/i.test(entity)) throw new HttpError(400, "Invalid activity filter");
      // The project-wide history is the owner's tool; per-entity history stays
      // available to every member because the page dialog shows it inline.
      if (!entity && user.role !== "owner") {
        throw new HttpError(403, "Only the project owner can open the project history");
      }
      const page = listAuditEvents(database, projectId, {
        entityId: entity ?? undefined,
        before: readPositiveInteger(url.searchParams.get("before")),
        limit: readPositiveInteger(url.searchParams.get("limit")) ?? AUDIT_PAGE_SIZE,
      });
      json(response, 200, page);
      return;
    }

    if (method === "GET" && url.pathname === "/api/away") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const latest = latestAuditSequence(database, projectId);
      let since = seenCursor(database, projectId, user.id);
      if (since === null) {
        initializeSeenCursor(database, projectId, user.id, latest);
        since = latest;
      }
      const unseen = listUnseenEvents(database, projectId, { after: since, excludeActorId: user.id });
      json(response, 200, { since, latest, total: unseen.total, events: unseen.events });
      return;
    }

    if (method === "POST" && url.pathname === "/api/seen") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const input = seenSchema.parse(await readJson(request));
      const latest = latestAuditSequence(database, projectId);
      advanceSeenCursor(database, projectId, user.id, Math.min(input.sequence ?? latest, latest));
      json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/board") {
      const user = requireUser(context);
      const board = getBoard(database, pageStore, chapterStore, user, requireProject(context, user));
      if (!board) throw new HttpError(404, "Board not found");
      json(response, 200, {
        ...board,
        currentUser: withAvatar(board.currentUser),
        members: board.members.map(withAvatar),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/search") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const input = searchSchema.parse(Object.fromEntries(url.searchParams));
      json(response, 200, searchProject(database, pageStore, chapterStore, ideaStore, projectId, input.q, input.limit));
      return;
    }

    if (method === "POST" && url.pathname === "/api/pages") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const input = pageSchema.parse(await readJson(request));
      if (input.chapter) requireChaptersEnabled(projectId);
      const page = createPage(database, pageStore, chapterStore, projectId, user.id, input);
      if (!page) throw new HttpError(400, "Assignee is not a member of this board");
      audit(user, {
        projectId,
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "created",
        changes: pageCreationChanges(page, labelsForProject(projectId)),
      });
      json(response, 201, { page });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "GET" && url.pathname === "/api/ideas") {
      const user = requireUser(context);
      const workspace = getIdeas(database, ideaStore, user, requireProject(context, user));
      if (!workspace) throw new HttpError(404, "Idea garden not found");
      json(response, 200, { ...workspace, currentUser: withAvatar(workspace.currentUser) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/ideas") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const idea = createIdea(
        database,
        ideaStore,
        projectId,
        user.id,
        ideaSchema.parse(await readJson(request)),
      );
      if (!idea) throw new HttpError(404, "Idea garden not found");
      audit(user, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action: "created" });
      json(response, 201, { idea });
      broadcast(projectId, "ideas", requestClientId(request));
      return;
    }

    const promotionMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)\/promote$/);
    if (method === "POST" && promotionMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      await readJson(request);
      const source = findIdea(database, ideaStore, projectId, promotionMatch[1]);
      const page = promoteIdea(
        database,
        pageStore,
        chapterStore,
        ideaStore,
        projectId,
        user.id,
        promotionMatch[1],
      );
      if (!page) throw new HttpError(404, "Idea not found");
      audit(user, {
        projectId,
        entityType: "idea",
        entityId: promotionMatch[1],
        entityTitle: source?.title ?? page.title,
        action: "promoted",
        changes: [{ field: "became a page", from: null, to: page.title }],
      });
      audit(user, {
        projectId,
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "created",
        changes: [{ field: "promoted from an idea", from: null, to: source?.title ?? page.title }],
      });
      json(response, 201, { page });
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    const promotionUndoMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)\/promotion$/);
    if (method === "DELETE" && promotionUndoMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const idea = undoPromotion(database, pageStore, ideaStore, projectId, promotionUndoMatch[1]);
      if (!idea) throw new HttpError(404, "Promoted idea not found");
      audit(user, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action: "restored" });
      json(response, 200, { idea });
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    const ideaMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)$/);
    if (method === "PATCH" && ideaMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const previousIdea = findIdea(database, ideaStore, projectId, ideaMatch[1]);
      const idea = updateIdea(
        database,
        ideaStore,
        projectId,
        ideaMatch[1],
        ideaUpdateSchema.parse(await readJson(request)),
      );
      if (!idea) throw new HttpError(404, "Idea not found");
      if (previousIdea) {
        const changes = ideaChanges(previousIdea, idea);
        const action = changeAction(changes);
        // Reranking the shortlist changes nothing a reader would look for.
        if (action) {
          audit(user, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action, changes });
        }
      }
      json(response, 200, { idea });
      broadcast(projectId, "ideas", requestClientId(request));
      return;
    }

    const pageRestoreMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/restore$/);
    if (method === "POST" && pageRestoreMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      await readJson(request);
      const page = restorePage(database, pageStore, projectId, pageRestoreMatch[1]);
      if (!page) throw new HttpError(404, "Archived page not found");
      audit(user, { projectId, entityType: "page", entityId: page.id, entityTitle: page.title, action: "restored" });
      json(response, 200, { page });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (method === "PATCH" && pageMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const labels = labelsForProject(projectId);
      const before = findPage(database, pageStore, projectId, pageMatch[1]);
      const input = pageUpdateSchema.parse(await readJson(request));
      if (input.chapter) requireChaptersEnabled(projectId);
      const page = updatePage(database, pageStore, chapterStore, projectId, pageMatch[1], input);
      if (!page) throw new HttpError(404, "Page or assignee not found");
      if (before) {
        const changes = pageChanges(before, page, labels);
        const action = changeAction(changes);
        // Reordering inside one column changes nothing a reader would look for.
        if (action) {
          audit(user, { projectId, entityType: "page", entityId: page.id, entityTitle: page.title, action, changes });
        }
      }
      json(response, 200, { page });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && pageMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const archived = findPage(database, pageStore, projectId, pageMatch[1]);
      if (!archivePage(database, pageStore, projectId, pageMatch[1])) {
        throw new HttpError(404, "Page not found");
      }
      audit(user, {
        projectId,
        entityType: "page",
        entityId: pageMatch[1],
        entityTitle: archived?.title ?? "a page",
        action: "archived",
      });
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    json(response, 404, { error: "Not found" });
  }

  function withAvatar<T extends User>(user: T): T {
    return { ...user, avatarUrl: avatarStore.urlFor(user.id) };
  }

  function audit(user: User, input: Omit<RecordAuditInput, "actor">): void {
    recordAuditEvent(database, { ...input, actor: { id: user.id, name: user.name } });
  }

  /**
   * Readable labels for a page diff, loaded only when a diff actually needs them.
   *
   * Most edits touch neither the category nor the blockers, and resolving blocker
   * titles means reading every page file in the project.
   */
  function labelsForProject(projectId: string): PageLabels {
    let categories: Map<string, string> | null = null;
    let chapters: Map<string, string> | null = null;
    let titles: Map<string, string> | null = null;
    return {
      categoryName: (slug) => {
        if (slug === null) return "uncategorized";
        categories ??= new Map(categoriesForProject(database, projectId).map((value) => [value.slug, value.name]));
        return categories.get(slug) ?? slug;
      },
      chapterName: (slug) => {
        if (slug === null) return "no chapter";
        chapters ??= new Map(
          chaptersForProject(database, chapterStore, projectId).map((value) => [value.slug, value.name]),
        );
        return chapters.get(slug) ?? slug;
      },
      pageTitle: (id) => {
        titles ??= new Map(listPages(database, pageStore, projectId).map((page) => [page.id, page.title]));
        return titles.get(id) ?? "a removed page";
      },
    };
  }

  /**
   * Refuses any chapter surface on a project that has not opted in.
   *
   * The gate is enforced here as well as in the interface, so turning chapters off is a real
   * boundary rather than a hidden set of routes.
   */
  function requireChaptersEnabled(projectId: string): void {
    if (!chaptersEnabled(database, projectId)) {
      throw new HttpError(403, "Chapters are not enabled for this project");
    }
  }

  /**
   * Chat clients fetch a shared link anonymously to unfurl it, so this runs without a
   * session and must never fail the page: a page that cannot be read falls back to the
   * generic Grimoire preview. Page and idea ids are unique across projects, so the link
   * only carries the id and the lookup walks the live projects to place it.
   */
  function linkPreviewFor(url: URL): LinkPreview | null {
    // `card` is what every link shared before the rename carries, and those links live in
    // other people's chat history forever. They keep working.
    const pageId = previewEntityId(url.searchParams.get("page") ?? url.searchParams.get("card"));
    const ideaId = previewEntityId(url.searchParams.get("idea"));
    if (!pageId && !ideaId) return null;
    try {
      for (const project of previewProjects()) {
        const projectName = String(project.name);
        const slug = String(project.slug);
        if (pageId) {
          const page = pageStore.get(slug, pageId) ?? pageStore.getArchived(slug, pageId);
          if (!page) continue;
          return pagePreview({
            assigneeName: memberName(page.assignee),
            page,
            categories: categoriesForProject(database, String(project.id)),
            chapterName: page.chapter && chaptersEnabled(database, String(project.id))
              ? chapterStore.get(slug, page.chapter)?.name ?? null
              : null,
            projectName,
          });
        }
        const idea = ideaStore.get(slug, ideaId!) ?? ideaStore.getArchived(slug, ideaId!);
        if (idea) return ideaPreview({ authorName: memberName(idea.createdBy), idea, projectName });
      }
    } catch (error) {
      console.error(error);
    }
    return null;
  }

  function previewProjects(): Array<Record<string, string | number | null>> {
    return database
      .prepare("SELECT id, name, slug FROM projects WHERE archived_at IS NULL ORDER BY created_at")
      .all() as Array<Record<string, string | number | null>>;
  }

  /** Pages and ideas store the email, and a member who has since left leaves no name behind. */
  function memberName(email: string | null): string | null {
    if (!email) return null;
    const stored = findUserByEmail(database, email);
    return stored ? String(stored.name) : null;
  }

  function requireProject(context: RequestContext, user: User): string {
    const header = context.request.headers["x-grimoire-project"];
    const fromHeader = typeof header === "string" ? header : header?.[0];
    const requested = (fromHeader ?? context.url.searchParams.get("project") ?? "").slice(0, 100);
    if (requested) {
      if (!userCanAccessProject(database, user, requested)) throw new HttpError(404, "Board not found");
      return requested;
    }
    const fallback = defaultProjectIdForUser(database, user);
    if (!fallback) throw new HttpError(404, "Board not found");
    return fallback;
  }

  function setSession(response: ServerResponse, userId: string): void {
    const token = createOpaqueToken();
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_AGE_SECONDS * 1000);
    database
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, hashToken(token), expires.toISOString(), now.toISOString());
    const secure = options.production ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secure}`,
    );
  }

  function clearSession(response: ServerResponse): void {
    const secure = options.production ? "; Secure" : "";
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  }

  function userForSession(token: string): User | null {
    const now = new Date().toISOString();
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const value = database
      .prepare(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(hashToken(token), now) as Record<string, string> | undefined;
    return value ? publicUser(value) : null;
  }

  function broadcast(projectId: string, scope: WorkspaceScope, excludedClientId: string | null): void {
    const message = `event: workspace\ndata: ${JSON.stringify({ scope })}\n\n`;
    for (const client of eventClients) {
      if (client.projectId !== projectId || (excludedClientId && client.clientId === excludedClientId)) continue;
      client.response.write(message);
    }
  }

  /**
   * Presence is derived from the live event streams rather than stored, so a browser
   * that closes, crashes, or loses its connection stops counting as present without
   * needing a heartbeat table or an expiry sweep.
   */
  function broadcastPresence(projectId: string): void {
    const online = new Set<string>();
    for (const client of eventClients) {
      if (client.projectId === projectId) online.add(client.userId);
    }
    const message = `event: presence\ndata: ${JSON.stringify({ online: [...online] })}\n\n`;
    for (const client of eventClients) {
      if (client.projectId !== projectId) continue;
      client.response.write(message);
    }
  }

  function disconnectUserEvents(userId: string): void {
    const affected = new Set<string>();
    for (const client of eventClients) {
      if (client.userId !== userId) continue;
      clearInterval(client.keepAlive);
      eventClients.delete(client);
      affected.add(client.projectId);
      client.response.end();
    }
    for (const projectId of affected) broadcastPresence(projectId);
  }

  function closeEventStreams(): void {
    for (const client of eventClients) {
      clearInterval(client.keepAlive);
      client.response.end();
    }
    eventClients.clear();
  }

  return {
    server,
    closeEventStreams,
    close: () => {
      if (databaseClosed) return;
      closeEventStreams();
      database.close();
      databaseClosed = true;
    },
  };
}

function requireUser(context: RequestContext): User {
  if (!context.user) throw new HttpError(401, "Authentication required");
  return context.user;
}

/** Ids name a file on disk, so anything that is not a plain uuid names nothing. */
function previewEntityId(value: string | null): string | null {
  if (value === null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function readPositiveInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

async function readRaw(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRaw(request, 1_000_000);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function requestClientId(request: IncomingMessage): string | null {
  const value = request.headers["x-grimoire-client-id"];
  if (typeof value === "string") return value.slice(0, 100);
  return value?.[0]?.slice(0, 100) ?? null;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

/** Unknown paths fall back to the shell so the client router can answer them. */
function resolveStaticPath(pathname: string, directory: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot name a build file, so the shell answers instead.
  }
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const filePath = join(directory, relative || "index.html");
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  const shell = join(directory, "index.html");
  return existsSync(shell) ? shell : null;
}

/** The shell is rewritten per request, so it is never stored by a cache or a proxy. */
function serveDocument(response: ServerResponse, filePath: string, preview: LinkPreview | null): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(applyLinkPreview(readFileSync(filePath, "utf8"), preview));
}

function serveFile(response: ServerResponse, filePath: string): void {
  const contentTypes: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
  };
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
  createReadStream(filePath).pipe(response);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
