import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { z, ZodError } from "zod";
import type { User } from "../shared/types";
import { createWizardSimulatorProject, openDatabase } from "./database";
import {
  archiveCard,
  createCard,
  findUserByEmail,
  findUserById,
  getBoard,
  projectIdForUser,
  publicUser,
  updateCard,
  userCount,
} from "./repository";
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from "./security";
import { MarkdownCardStore } from "./markdown-cards";

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

const cardStatus = z.enum(["backlog", "ready", "in_progress", "done"]);
const cardSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  status: cardStatus.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
const cardUpdateSchema = cardSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});

export function createGrimoireServer(options: Options) {
  const database = openDatabase(options.databasePath);
  const cardStore = new MarkdownCardStore(options.cardsDirectory ?? join(dirname(options.databasePath), "cards"));
  cardStore.migrateLegacyCards(database);
  let databaseClosed = false;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof ZodError) {
        json(response, 400, { error: "Invalid request", details: error.issues });
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
      else json(response, 200, { status: "authenticated", user: context.user });
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
      const user = publicUser(findUserById(database, userId)!);
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
      if (!stored || !passwordMatches) throw new HttpError(401, "Email or password is incorrect");
      const user = publicUser(stored);
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
      const user = publicUser(findUserById(database, userId)!);
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
      database
        .prepare("INSERT INTO invites (id, code_hash, created_by, expires_at, used_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
        .run(randomUUID(), hashToken(code), user.id, expires.toISOString(), now.toISOString());
      json(response, 201, { code, expiresAt: expires.toISOString() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/board") {
      const user = requireUser(context);
      const board = getBoard(database, cardStore, user);
      if (!board) throw new HttpError(404, "Board not found");
      json(response, 200, board);
      return;
    }

    if (method === "POST" && url.pathname === "/api/cards") {
      const user = requireUser(context);
      const projectId = requireProjectId(user.id);
      const card = createCard(database, cardStore, projectId, user.id, cardSchema.parse(await readJson(request)));
      if (!card) throw new HttpError(400, "Assignee is not a member of this board");
      json(response, 201, { card });
      return;
    }

    const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (method === "PATCH" && cardMatch) {
      const user = requireUser(context);
      const card = updateCard(
        database,
        cardStore,
        requireProjectId(user.id),
        cardMatch[1],
        cardUpdateSchema.parse(await readJson(request)),
      );
      if (!card) throw new HttpError(404, "Card or assignee not found");
      json(response, 200, { card });
      return;
    }

    if (method === "DELETE" && cardMatch) {
      const user = requireUser(context);
      if (!archiveCard(database, cardStore, requireProjectId(user.id), cardMatch[1])) {
        throw new HttpError(404, "Card not found");
      }
      json(response, 200, { ok: true });
      return;
    }

    json(response, 404, { error: "Not found" });
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

  return {
    server,
    close: () => {
      if (databaseClosed) return;
      database.close();
      databaseClosed = true;
    },
  };
}

function requireUser(context: RequestContext): User {
  if (!context.user) throw new HttpError(401, "Authentication required");
  return context.user;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) throw new HttpError(413, "Request body is too large");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
