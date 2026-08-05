import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { z, ZodError } from "zod";
import { CARD_CATEGORIES, type User } from "../shared/types";
import { createWizardSimulatorProject, openDatabase } from "./database";
import {
  archiveCard,
  CardDependencyError,
  createCard,
  findUserByEmail,
  findUserById,
  getBoard,
  projectIdForUser,
  publicUser,
  removeProjectMember,
  restoreCard,
  updateCard,
  userCount,
} from "./repository";
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from "./security";
import { AVATAR_SIZE_LIMIT, AvatarStore, sniffAvatarType } from "./avatars";
import { MarkdownCardStore } from "./markdown-cards";
import { createIdea, getIdeas, promoteIdea, undoPromotion, updateIdea } from "./ideas-repository";
import { MarkdownIdeaStore } from "./markdown-ideas";

const SESSION_COOKIE = "grimoire_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

type Options = {
  cardsDirectory?: string;
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

const cardStatus = z.enum(["backlog", "ready", "in_progress", "review", "done"]);
const cardSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  category: z.enum(CARD_CATEGORIES).nullable().optional(),
  blockedBy: z.array(z.string().uuid()).max(20).optional(),
  status: cardStatus.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
const cardUpdateSchema = cardSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});
const ideaState = z.enum(["inbox", "shortlist", "parked"]);
const ideaSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  state: ideaState.optional(),
});
const ideaUpdateSchema = ideaSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});

export function createGrimoireServer(options: Options) {
  const database = openDatabase(options.databasePath);
  const cardStore = new MarkdownCardStore(options.cardsDirectory ?? join(dirname(options.databasePath), "cards"));
  const ideaStore = new MarkdownIdeaStore(cardStore.rootDirectory);
  const avatarStore = new AvatarStore(join(dirname(options.databasePath), "avatars"));
  cardStore.migrateLegacyCards(database);
  let databaseClosed = false;
  const eventClients = new Set<EventClient>();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof ZodError) {
        json(response, 400, { error: "Invalid request", details: error.issues });
        return;
      }
      if (error instanceof CardDependencyError) {
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
      serveStatic(response, url.pathname, options.staticDirectory);
      return;
    }
    json(response, 404, { error: "Not found" });
  }

  async function handleApi(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    const method = request.method ?? "GET";

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
      try {
        createWizardSimulatorProject(database, userId);
      } catch (error) {
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        throw error;
      }
      const user = withAvatar(publicUser(findUserById(database, userId)!));
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
      const projectId = stored ? projectIdForUser(database, String(stored.id)) : null;
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

    if (method === "PUT" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      const data = await readRaw(request, AVATAR_SIZE_LIMIT);
      const imageType = sniffAvatarType(data);
      if (!imageType) throw new HttpError(400, "Profile picture must be a PNG, JPEG, or WebP image");
      avatarStore.save(user.id, data, imageType);
      json(response, 200, { avatarUrl: avatarStore.urlFor(user.id) });
      broadcast(requireProjectId(user.id), "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      avatarStore.remove(user.id);
      json(response, 200, { ok: true });
      broadcast(requireProjectId(user.id), "work", requestClientId(request));
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

    if (method === "POST" && url.pathname === "/api/auth/register") {
      const input = registerSchema.parse(await readJson(request));
      const invite = database.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hashToken(input.inviteCode)) as
        | Record<string, string | null>
        | undefined;
      if (!invite || invite.used_by || String(invite.expires_at) <= new Date().toISOString()) {
        throw new HttpError(409, "Invitation is invalid or has already been used");
      }
      if (findUserByEmail(database, input.email)) throw new HttpError(409, "An account already uses this email");
      const projectId = projectIdForUser(database, String(invite.created_by));
      if (!projectId) throw new HttpError(409, "Invitation project no longer exists");
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
      setSession(response, userId);
      json(response, 201, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/api/invites") {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the project owner can create invitations");
      await readJson(request);
      const code = createOpaqueToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("DELETE FROM invites WHERE created_by = ? AND used_by IS NULL").run(user.id);
        database
          .prepare("INSERT INTO invites (id, code_hash, created_by, expires_at, used_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
          .run(randomUUID(), hashToken(code), user.id, expires.toISOString(), now.toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      json(response, 201, { code, expiresAt: expires.toISOString() });
      return;
    }

    const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
    if (method === "DELETE" && memberMatch) {
      const user = requireUser(context);
      if (user.role !== "owner") throw new HttpError(403, "Only the project owner can remove members");
      await readJson(request);
      const projectId = requireProjectId(user.id);
      const result = removeProjectMember(database, cardStore, projectId, memberMatch[1]);
      if (result === "owner") throw new HttpError(409, "The project owner cannot be removed");
      if (result === "not_found") throw new HttpError(404, "Member not found");
      disconnectUserEvents(memberMatch[1]);
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
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
      const remove = () => {
        clearInterval(client.keepAlive);
        eventClients.delete(client);
      };
      response.once("close", remove);
      return;
    }

    if (method === "GET" && url.pathname === "/api/board") {
      const user = requireUser(context);
      const board = getBoard(database, cardStore, user);
      if (!board) throw new HttpError(404, "Board not found");
      json(response, 200, {
        ...board,
        currentUser: withAvatar(board.currentUser),
        members: board.members.map(withAvatar),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/cards") {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const card = createCard(database, cardStore, projectId, user.id, cardSchema.parse(await readJson(request)));
      if (!card) throw new HttpError(400, "Assignee is not a member of this board");
      json(response, 201, { card });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "GET" && url.pathname === "/api/ideas") {
      const user = requireUser(context);
      const workspace = getIdeas(database, ideaStore, user, requireProjectId(user.id));
      if (!workspace) throw new HttpError(404, "Idea garden not found");
      json(response, 200, { ...workspace, currentUser: withAvatar(workspace.currentUser) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/ideas") {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const idea = createIdea(
        database,
        ideaStore,
        projectId,
        user.id,
        ideaSchema.parse(await readJson(request)),
      );
      if (!idea) throw new HttpError(404, "Idea garden not found");
      json(response, 201, { idea });
      broadcast(projectId, "ideas", requestClientId(request));
      return;
    }

    const promotionMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)\/promote$/);
    if (method === "POST" && promotionMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      await readJson(request);
      const card = promoteIdea(
        database,
        cardStore,
        ideaStore,
        projectId,
        user.id,
        promotionMatch[1],
      );
      if (!card) throw new HttpError(404, "Idea not found");
      json(response, 201, { card });
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    const promotionUndoMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)\/promotion$/);
    if (method === "DELETE" && promotionUndoMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const idea = undoPromotion(database, cardStore, ideaStore, projectId, promotionUndoMatch[1]);
      if (!idea) throw new HttpError(404, "Promoted idea not found");
      json(response, 200, { idea });
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    const ideaMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)$/);
    if (method === "PATCH" && ideaMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const idea = updateIdea(
        database,
        ideaStore,
        projectId,
        ideaMatch[1],
        ideaUpdateSchema.parse(await readJson(request)),
      );
      if (!idea) throw new HttpError(404, "Idea not found");
      json(response, 200, { idea });
      broadcast(projectId, "ideas", requestClientId(request));
      return;
    }

    const cardRestoreMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/restore$/);
    if (method === "POST" && cardRestoreMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      await readJson(request);
      const card = restoreCard(database, cardStore, projectId, cardRestoreMatch[1]);
      if (!card) throw new HttpError(404, "Archived card not found");
      json(response, 200, { card });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (method === "PATCH" && cardMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const card = updateCard(
        database,
        cardStore,
        projectId,
        cardMatch[1],
        cardUpdateSchema.parse(await readJson(request)),
      );
      if (!card) throw new HttpError(404, "Card or assignee not found");
      json(response, 200, { card });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && cardMatch) {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      if (!archiveCard(database, cardStore, projectId, cardMatch[1])) {
        throw new HttpError(404, "Card not found");
      }
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    json(response, 404, { error: "Not found" });
  }

  function withAvatar<T extends User>(user: T): T {
    return { ...user, avatarUrl: avatarStore.urlFor(user.id) };
  }

  function requireProjectId(userId: string): string {
    const projectId = projectIdForUser(database, userId);
    if (!projectId) throw new HttpError(404, "Board not found");
    return projectId;
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

  function disconnectUserEvents(userId: string): void {
    for (const client of eventClients) {
      if (client.userId !== userId) continue;
      clearInterval(client.keepAlive);
      eventClients.delete(client);
      client.response.end();
    }
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

function serveStatic(response: ServerResponse, pathname: string, directory: string): void {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let filePath = join(directory, relative || "index.html");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(directory, "index.html");
  if (!existsSync(filePath)) {
    json(response, 404, { error: "Application build not found" });
    return;
  }
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
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
