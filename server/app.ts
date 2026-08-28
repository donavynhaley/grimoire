import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { z, ZodError } from "zod";
import { BODY_MAX_LENGTH, DISCUSSION_BODY_MAX_LENGTH, FIELD_TYPES, PAGE_STATUSES, type PageGithubLink, type PageStatus, type User } from "../shared/types";
import {
  findThread,
  listDiscussion,
  markSeen as markDiscussionSeen,
  openThread,
  parseMentions,
  replyToThread,
  setThreadAnswered,
} from "./discussion";
import { buildRecap, discordPoster, postRecap, recapMessages, type DiscordPoster } from "./recap";
import { forgetOpenPullRequests, githubApiFetcher, listOpenPullRequests, normalizeRepo, parseGithubReference, syncProjectGithub, verifyRepoAccess, type GithubFetcher } from "./github";
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
  createField,
  defaultProjectIdForUser,
  deleteCategory,
  deleteChapter,
  deleteField,
  fieldsForProject,
  EditConflictError,
  findPage,
  findUserByEmail,
  findUserById,
  getBoard,
  listPages,
  listProjectsForUser,
  advanceSeenCursor,
  initializeSeenCursor,
  listArchivedProjects,
  addProjectMember,
  membersForProject,
  projectById,
  projectSlug,
  publicUser,
  seenCursor,
  removeProjectMember,
  renameProject,
  restorePage,
  restoreProject,
  setChaptersEnabled,
  setProjectDescription,
  setMemberRole,
  updatePage,
  updateCategory,
  updateChapter,
  updateField,
  userCanAccessProject,
  userOwnsProject,
  userCount,
  projectGithubConfig,
  setProjectGithub,
  clearGithubStatus,
  closeChapter,
  nextChapterAfter,
  projectRecapConfig,
  setProjectRecap,
  publicChapter,
  setEstimatesEnabled,
  estimatesEnabled,
} from "./repository";
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from "./security";
import {
  clientAddress,
  LOGIN_ACCOUNT_BURST,
  LOGIN_ACCOUNT_PER_MINUTE,
  LOGIN_ADDRESS_BURST,
  LOGIN_ADDRESS_PER_MINUTE,
  LoginRateLimiter,
} from "./login-rate-limit";
import {
  DEFAULT_SCOPES as DEFAULT_OIDC_SCOPES,
  newSignInSecrets,
  OidcError,
  oidcHttpFetcher,
  parseIssuerInput,
  PendingSignIns,
  providerBrand,
  safeReturnPath,
  type OidcConfig,
  type OidcFetcher,
  type OidcIdentity,
} from "./oidc";
import { emailAllowed, oidcSettingsView, OidcProviders, resolveOidc, saveOidcSettings } from "./oidc-settings";
import { findOidcLink, linkOidcIdentity, oidcLinkForUser, touchOidcLink } from "./oidc-identities";
import {
  AgentRateLimiter,
  agentForToken,
  issueAgentToken,
  listAgentTokens,
  revokeAgentToken,
  touchAgentToken,
  type AgentIdentity,
} from "./agent-tokens";
import { AVATAR_SIZE_LIMIT, AvatarStore, sniffAvatarType } from "./avatars";
import { IMAGE_SIZE_LIMIT, ProjectImageStore, sniffImageType } from "./project-images";
import { MarkdownPageStore } from "./markdown-pages";
import { isCalendarDay, MarkdownChapterStore } from "./markdown-chapters";
import { createIdea, findIdea, getIdeas, promoteIdea, undoPromotion, updateIdea } from "./ideas-repository";
import { MarkdownIdeaStore } from "./markdown-ideas";
import { searchProject } from "./search";
import { applyLinkPreview, pagePreview, ideaPreview, type LinkPreview } from "./link-preview";
import { CHAPTER_STATE_LABELS,
  PAGE_COLUMN_LABELS,
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
  summarize,
  type PageLabels,
  type RecordAuditInput,
} from "./audit";

const SESSION_COOKIE = "grimoire_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;
/**
 * Ties a provider callback to the browser that started the flow.
 *
 * Scoped to the callback route so it is sent on exactly one request, and `SameSite=Lax` rather
 * than `Strict` because the browser arrives back here from the provider's origin and a strict
 * cookie would not be sent on that navigation at all.
 */
const OIDC_STATE_COOKIE = "grimoire_oidc_state";

type Options = {
  pagesDirectory?: string;
  databasePath: string;
  production: boolean;
  staticDirectory?: string;
  /** How often linked pages ask GitHub what happened; 0 disables the poller. */
  githubPollMs?: number;
  /** Stands in for the GitHub API in tests. */
  githubFetcher?: GithubFetcher;
  /** Stands in for Discord in tests. */
  discordPoster?: DiscordPoster;
  /** The identity provider people may sign in through, when the operator configured one. */
  oidc?: OidcConfig | null;
  /** Stands in for that provider in tests. */
  oidcFetcher?: OidcFetcher;
  /**
   * Whether something in front of Grimoire is writing `X-Forwarded-For`.
   *
   * It decides who a sign-in attempt is counted against, so it is a deployment fact rather
   * than a preference: wrong in one direction every visitor shares one allowance, wrong in
   * the other the allowance is free to walk around.
   */
  trustProxy?: boolean;
};

type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  user: User | null;
  sessionToken: string | null;
  /** Set when a bearer token answered instead of a browser session. */
  agent: AgentIdentity | null;
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

/**
 * The provider settings screen, field by field.
 *
 * Every field is optional because the screen saves as it goes rather than as one form: an
 * operator pastes an address, checks it, pastes a client id, and each of those is a save. A
 * missing `clientSecret` therefore has to mean "leave the stored one alone" rather than
 * "clear it", or every other edit would silently forget the secret.
 */
const oidcSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  issuer: z.string().trim().max(400).optional(),
  clientId: z.string().trim().max(300).optional(),
  clientSecret: z.string().trim().max(600).optional(),
  scopes: z.string().trim().max(300).optional(),
  label: z.string().trim().max(60).optional(),
  autoRegister: z.boolean().optional(),
  allowedEmailDomains: z.string().trim().max(500).optional(),
  redirectUri: z.string().trim().max(400).optional(),
  signupProject: z.string().trim().max(100).optional(),
});

const oidcProbeSchema = z.object({
  issuer: z.string().trim().min(1).max(400),
  clientId: z.string().trim().max(300).optional(),
});

const pageStatus = z.enum(["backlog", "ready", "in_progress", "review", "done"]);
const categorySlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40);
const chapterSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60);
const calendarDay = z.string().refine(isCalendarDay, "Expected a YYYY-MM-DD day");
/**
 * Values for the project's own fields, as a patch. `null` clears one; an absent key is left
 * alone. The shapes are checked here and the meanings against the project's definitions,
 * because only the project knows what `priority` is allowed to say.
 */
const pageFieldPatch = z.record(
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40),
  z.union([z.string().trim().max(200), z.number().finite(), z.boolean(), z.null()]),
);
const pageSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  category: categorySlug.nullable().optional(),
  chapter: chapterSlug.nullable().optional(),
  fields: pageFieldPatch.optional(),
  blockedBy: z.array(z.string().uuid()).max(20).optional(),
  status: pageStatus.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  estimate: z.number().finite().min(0).max(100_000).nullable().optional(),
});
/**
 * Compare-and-swap fields, sent only for the content a client is actually rewriting.
 * A save that omits them keeps the previous last-writer-wins behaviour, which is what
 * ordering and column moves want - a drag has no content to lose.
 */
const contentPreconditions = {
  expectedTitle: z.string().trim().max(240).optional(),
  expectedDescription: z.string().trim().max(BODY_MAX_LENGTH).optional(),
};
const pageUpdateSchema = pageSchema.partial().extend({
  /** A pasted reference - PR URL, #123, branch, or branch URL - or null to unlink. */
  github: z.string().trim().max(400).nullable().optional(),
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});
const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
});
const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(2000).optional(),
    chaptersEnabled: z.boolean().optional(),
    discordWebhook: z.string().trim().max(500).optional(),
    recapOnClose: z.boolean().optional(),
    githubRepo: z.string().trim().max(200).optional(),
    githubToken: z.string().trim().max(300).optional(),
    estimatesEnabled: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.chaptersEnabled !== undefined ||
      input.githubRepo !== undefined ||
      input.githubToken !== undefined ||
      input.estimatesEnabled !== undefined ||
      input.discordWebhook !== undefined ||
      input.recapOnClose !== undefined,
    { message: "Nothing to update" },
  );
const chapterState = z.enum(["planned", "open", "closed"]);
const chapterCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  startsOn: calendarDay.nullable().optional(),
  endsOn: calendarDay.nullable().optional(),
  state: chapterState.optional(),
});
/**
 * How a closing chapter disposes of what it did not finish. "next" is the planned chapter
 * after it, "release" sets the work loose, "keep" leaves it where it is, and a slug names
 * somewhere exactly.
 */
const chapterCloseSchema = z.object({
  rollover: z.union([z.literal("next"), z.literal("release"), z.literal("keep"), chapterSlug]).optional(),
});
const chapterUpdateSchema = chapterCreateSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  expectedDescription: z.string().trim().max(BODY_MAX_LENGTH).optional(),
});
const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(32),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
const categoryUpdateSchema = categoryCreateSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});
const fieldCreateSchema = z.object({
  label: z.string().trim().min(1).max(40),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
  showOnTile: z.boolean().optional(),
});
/**
 * The type is here only so a choice field can change how it asks. Every other type change is
 * still refused - `updateField` settles which pairings are safe, since it is the one that
 * knows what the stored values would have to survive.
 */
const fieldUpdateSchema = fieldCreateSchema
  .partial()
  .extend({ position: z.number().int().min(0).optional() });
const ideaState = z.enum(["inbox", "shortlist", "parked"]);
const ideaSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(BODY_MAX_LENGTH).optional(),
  state: ideaState.optional(),
});
const ideaUpdateSchema = ideaSchema.partial().extend({
  position: z.number().int().min(0).optional(),
  ...contentPreconditions,
});

const memberRoleSchema = z.object({ role: z.enum(["owner", "member"]) }).strict();
/** Naming an account outright, because the alternative is listing everyone to choose from. */
const memberAddSchema = z.object({ email: z.string().trim().email().max(320) }).strict();

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

const discussionBodySchema = z
  .object({ body: z.string().trim().min(1).max(DISCUSSION_BODY_MAX_LENGTH) })
  .strict();
const discussionAnswerSchema = z.object({ answered: z.boolean() }).strict();

const AGENT_PAGE_PATH = /^\/api\/pages\/[^/]+$/;
const AGENT_IDEA_PATH = /^\/api\/ideas\/[^/]+$/;
const AGENT_DISCUSSION_PATH = /^\/api\/pages\/[^/]+\/discussion$/;
const AGENT_REPLY_PATH = /^\/api\/pages\/[^/]+\/discussion\/[^/]+\/replies$/;

/**
 * Whether an agent token may use a route at all, and whether doing so is a write.
 *
 * The rule the list encodes: an agent may add and refine, and only a person may destroy or
 * restructure. So creating and editing pages and ideas is open, while archiving, restoring,
 * promoting an idea, and anything that reshapes the project - chapters, categories, members,
 * invitations, the project itself - is closed no matter how the token is scoped. Archiving
 * is the sharpest of those: its undo is eight seconds long and built for a person who just
 * clicked, so an agent that archived thirty pages would leave no path anyone would find.
 *
 * Account routes are closed because a delegated credential must not be able to escalate into
 * the identity it borrows. The event stream is closed because presence is derived from open
 * streams, and an agent holding one would appear to be a teammate sitting in the project.
 *
 * `null` means refuse. Reads are unmetered; writes are charged against the rate limit.
 */
function agentMayReach(method: string, pathname: string): "read" | "write" | null {
  if (method === "GET") {
    if (pathname === "/api/health" || pathname === "/api/session") return "read";
    if (pathname === "/api/board" || pathname === "/api/search" || pathname === "/api/ideas") return "read";
    // One page, for an agent that already knows which one it wants. Reading a single page by
    // pulling the whole board is what an agent had to do before, and on a large project that
    // is most of a megabyte to answer a question about one title.
    if (AGENT_PAGE_PATH.test(pathname)) return "read";
    // Reading the discussion is how an agent finds out what it was asked, which is the point
    // of letting it write there at all.
    if (AGENT_DISCUSSION_PATH.test(pathname)) return "read";
    // The activity log is owner-only, and the route enforces that against the person the
    // token acts as. A token therefore never reads more than its issuer already could.
    if (pathname === "/api/activity") return "read";
    return null;
  }
  if (method === "POST" && (pathname === "/api/pages" || pathname === "/api/ideas")) return "write";
  if (method === "PATCH" && (AGENT_PAGE_PATH.test(pathname) || AGENT_IDEA_PATH.test(pathname))) return "write";
  /*
   * Opening a thread and replying to one are the two writes an agent is most obviously good
   * for: reporting what it did, and answering when asked. Both are additions to a page that a
   * person can read and argue with, which is exactly the shape of write agents are trusted
   * with everywhere else here.
   *
   * Marking a thread answered is absent by design, and so is anything that would edit or
   * delete what was said. An agent that could close the question it raised could report its
   * own work settled, and the one judgement a discussion carries would stop meaning anything.
   */
  if (method === "POST" && (AGENT_DISCUSSION_PATH.test(pathname) || AGENT_REPLY_PATH.test(pathname))) return "write";
  // Marking a conversation read is a claim about a person's attention, and an agent has none.
  return null;
}

const agentTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(["read", "write"]),
  /** Optional, because an agent that runs indefinitely is a legitimate thing to want. */
  expiresAt: z.string().datetime().nullable().optional(),
});

export function createGrimoireServer(options: Options) {
  const database = openDatabase(options.databasePath);
  // Verified against for an email no account answers to, so an unknown address costs
  // exactly one derivation - the same as a known one. Hashing the placeholder inside
  // the request would spend a second derivation, and that difference is measurable.
  const placeholderPasswordHash = hashPassword(createOpaqueToken());
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
  // Per-token write allowance. In memory on purpose: it guards this process against a
  // runaway loop, and persisting it would mean a write on every request to limit writes.
  const writeLimiter = new AgentRateLimiter();
  // Password guesses, counted against where they came from and against the account they name.
  const loginAddressLimiter = new LoginRateLimiter({ burst: LOGIN_ADDRESS_BURST, perMinute: LOGIN_ADDRESS_PER_MINUTE });
  const loginAccountLimiter = new LoginRateLimiter({ burst: LOGIN_ACCOUNT_BURST, perMinute: LOGIN_ACCOUNT_PER_MINUTE });
  const trustProxy = options.trustProxy ?? false;
  const environmentOidc = options.oidc ?? null;
  const oidcProviders = new OidcProviders(options.oidcFetcher ?? oidcHttpFetcher);
  const pendingSignIns = new PendingSignIns();
  /**
   * The provider as it stands on this request.
   *
   * Read every time rather than held from boot, because the settings screen exists so that
   * turning single sign-on on is not a restart of the server everybody else is working in.
   */
  const currentOidc = () => resolveOidc(database, environmentOidc);

  /**
   * The board following the code: linked pages are brought up to date with GitHub on an
   * interval, and immediately when a link or a repository is set, so the first answer never
   * waits for the clock. Auto-moves are audited under the actor "GitHub" - a name, not a
   * member - so the log says plainly that the robot did it.
   */
  const githubDeps = {
    database,
    pageStore,
    chapterStore,
    fetcher: options.githubFetcher ?? githubApiFetcher,
    onMoved: ({ projectId, page, from, to }: { projectId: string; page: { id: string; title: string }; from: string; to: string }) => {
      recordAuditEvent(database, {
        projectId,
        actor: { id: null, name: "GitHub" },
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "moved",
        changes: [{
          field: "column",
          from: PAGE_COLUMN_LABELS[from as PageStatus],
          to: PAGE_COLUMN_LABELS[to as PageStatus],
        }],
      });
    },
    onChanged: (projectId: string) => broadcast(projectId, "work", null),
  };
  /**
   * The facts about one chapter, gathered once.
   *
   * Served and posted from the same call on purpose: a payload an agent reads to write the
   * story has to be the payload the plain message was built from, or the two accounts of a
   * sprint drift apart.
   */
  function recapFor(projectId: string, slug: string) {
    const project = projectById(database, projectId);
    if (!project) return null;
    const projectSlug = String(project.slug);
    const chapters = chapterStore.list(projectSlug);
    const chapter = chapters.find((candidate) => candidate.slug === slug);
    if (!chapter) return null;
    const members = membersForProject(database, projectId);
    // Everything closed before this one, which is what an average is taken across.
    const previous = chapters.filter(
      (candidate) => candidate.slug !== slug && candidate.closedAt !== null && candidate.closedAt < (chapter.closedAt ?? "9999"),
    );
    return buildRecap(
      chapter,
      previous,
      pageStore.list(projectSlug),
      members,
      publicChapter(database, chapter, members),
    );
  }

  /** Posts a chapter's recap, and says plainly why it did not when it did not. */
  async function sendRecap(projectId: string, slug: string): Promise<{ sent: number; failed: number } | "no_webhook" | "not_found"> {
    const config = projectRecapConfig(database, projectId);
    if (!config.webhook) return "no_webhook";
    const recap = recapFor(projectId, slug);
    if (!recap) return "not_found";
    const messages = recapMessages(recap, estimatesEnabled(database, projectId));
    return postRecap(options.discordPoster ?? discordPoster, config.webhook, messages);
  }

  async function runGithubSync(projectId: string): Promise<void> {
    try {
      await syncProjectGithub(githubDeps, projectId);
    } catch (error) {
      console.error("github sync failed", error);
    }
  }
  async function runAllGithubSync(): Promise<void> {
    const projects = database
      .prepare("SELECT id FROM projects WHERE github_repo != '' AND archived_at IS NULL")
      .all() as Array<{ id: string }>;
    for (const project of projects) await runGithubSync(String(project.id));
  }
  const githubPollMs = options.githubPollMs ?? 120_000;
  const githubPoll = githubPollMs > 0 ? setInterval(() => void runAllGithubSync(), githubPollMs) : null;
  // The poll must never be the reason the process cannot exit.
  githubPoll?.unref?.();

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
    const session = sessionToken ? userForSession(sessionToken) : null;
    // A bearer token is only consulted when no browser session answered, so a signed-in tab
    // can never be silently re-attributed to an agent, and a person who happens to hold a
    // token stays a person for as long as they are logged in.
    const agent = session ? null : agentForBearer(request);
    const context: RequestContext = {
      request,
      response,
      url,
      user: session ?? agent?.user ?? null,
      sessionToken,
      agent,
    };

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

    // What an agent may reach is an allow list rather than a set of refusals scattered
    // through the routes below, so a route added later is closed to agents until someone
    // decides otherwise. Forgetting to open a route is a bug report; forgetting to close
    // one would be a hole.
    if (context.agent) {
      const permitted = agentMayReach(method, url.pathname);
      if (!permitted) throw new HttpError(403, "An agent token cannot use this route");
      if (permitted === "write") requireAgentWrite(context);
      // Any permitted request counts as use, reads included. "Last used" is the signal an
      // owner reads to decide a credential is safe to revoke, and a read-only agent that
      // works all day but lists as never used would invite exactly the wrong revocation.
      touchAgentToken(database, context.agent.tokenId);
    }

    if (method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/session") {
      // What the sign-in screen needs to know before anybody has signed in: whether there is
      // a second door, and what to call it. Nothing here is a secret - the client id and the
      // provider's name are both public parts of the flow.
      const configured = currentOidc().config;
      const brand = configured ? providerBrand(configured.issuer) : null;
      const signInOptions = configured
        ? { oidc: { label: configured.label, ...(brand ? { brand } : {}) } }
        : {};
      if (userCount(database) === 0) json(response, 200, { status: "setup_required", ...signInOptions });
      else if (!context.user) json(response, 200, { status: "anonymous", ...signInOptions });
      else {
        json(response, 200, {
          status: "authenticated",
          user: withAvatar(context.user),
          ...signInOptions,
          // Tells a credential what it is, so an agent client can shape its own surface -
          // a read-only agent that knows its scope never offers itself a write tool.
          ...(context.agent ? { agent: { name: context.agent.name, scope: context.agent.scope } } : {}),
        });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/bootstrap") {
      if (userCount(database) !== 0) throw new HttpError(409, "Setup is already complete");
      const input = accountSchema.parse(await readJson(request));
      const userId = randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(input.password);
      // The one admin this installation ever has: whoever stood it up. Nothing grants the
      // role afterwards and nothing takes it away, which is what makes it the account that
      // can never be locked out of its own instance. "One, ever" is enforced by the INSERT
      // itself rather than by the check above, because that check and this write are
      // separated by two awaits - two racing setup requests would both pass it.
      const inserted = database
        .prepare(
          `INSERT INTO users (id, name, email, password_hash, role, created_at)
           SELECT ?, ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
        )
        .run(userId, input.name, input.email, passwordHash, now);
      if (Number(inserted.changes) !== 1) throw new HttpError(409, "Setup is already complete");
      let projectId: string;
      try {
        projectId = createWizardSimulatorProject(database, userId);
      } catch (error) {
        database.prepare("DELETE FROM users WHERE id = ?").run(userId);
        throw error;
      }
      const user = withAvatar(publicUser(findUserById(database, userId)!));
      auditAs(user, { projectId, entityType: "project", entityId: projectId, entityTitle: "Wizard Simulator", action: "created" });
      auditAs(user, { projectId, entityType: "member", entityId: userId, entityTitle: user.name, action: "joined" });
      setSession(response, userId);
      json(response, 201, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/login") {
      const input = loginSchema.parse(await readJson(request));
      const address = clientAddress(request, trustProxy);
      // Checked before the password is verified, so a refused attempt costs a comparison
      // rather than the deliberately slow hash the password itself is worth.
      const exhausted = !loginAddressLimiter.allows(address) || !loginAccountLimiter.allows(input.email);
      if (exhausted) {
        const wait = Math.max(
          loginAddressLimiter.retryAfterSeconds(address),
          loginAccountLimiter.retryAfterSeconds(input.email),
        );
        response.setHeader("Retry-After", String(wait));
        throw new HttpError(429, "Too many sign-in attempts. Try again shortly.");
      }
      const stored = findUserByEmail(database, input.email);
      const passwordMatches = stored
        ? await verifyPassword(input.password, String(stored.password_hash))
        : await verifyPassword(input.password, await placeholderPasswordHash);
      const projectId = stored ? defaultProjectIdForUser(database, publicUser(stored)) : null;
      if (!stored || !passwordMatches || !projectId) {
        loginAddressLimiter.spend(address);
        loginAccountLimiter.spend(input.email);
        throw new HttpError(401, "Email or password is incorrect");
      }
      // A right answer is not a guess, so it clears what the wrong ones before it cost.
      loginAddressLimiter.forget(address);
      loginAccountLimiter.forget(input.email);
      const user = withAvatar(publicUser(stored));
      setSession(response, user.id);
      json(response, 200, { user });
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/oidc") {
      const { config: oidcConfig } = currentOidc();
      if (!oidcConfig) throw new HttpError(404, "No sign-in provider is configured");
      const oidc = oidcProviders.for(oidcConfig);
      const secrets = newSignInSecrets();
      const redirectUri = oidcRedirectUri(request, url, oidcConfig);
      const invite = url.searchParams.get("invite");
      pendingSignIns.open({
        state: secrets.state,
        verifier: secrets.verifier,
        nonce: secrets.nonce,
        redirectUri,
        invite: invite && invite.length <= 200 ? invite : null,
        returnTo: safeReturnPath(url.searchParams.get("return")),
      });
      let destination: string;
      try {
        destination = await oidc.authorizationUrl({ redirectUri, ...secrets });
      } catch (error) {
        redirectToSignIn(response, "/", oidcMessage(error));
        return;
      }
      // The state also rides in a cookie, so a callback has to arrive in the same browser that
      // started the flow. Without it an attacker who completed their own sign-in could hand
      // somebody a callback link and quietly land them in the attacker's account.
      appendCookie(response, `${OIDC_STATE_COOKIE}=${secrets.state}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600${options.production ? "; Secure" : ""}`);
      response.statusCode = 302;
      response.setHeader("Location", destination);
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/oidc/callback") {
      const { config: oidcConfig } = currentOidc();
      if (!oidcConfig) throw new HttpError(404, "No sign-in provider is configured");
      const oidc = oidcProviders.for(oidcConfig);
      appendCookie(response, `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0${options.production ? "; Secure" : ""}`);
      const state = url.searchParams.get("state") ?? "";
      const cookieState = readCookie(request, OIDC_STATE_COOKIE);
      const pending = state && cookieState === state ? pendingSignIns.claim(state) : null;
      if (!pending) {
        redirectToSignIn(response, "/", "That sign-in has expired. Try again.");
        return;
      }
      // The provider says no by redirecting back with a reason rather than by failing.
      const refusal = url.searchParams.get("error");
      if (refusal) {
        redirectToSignIn(response, pending.returnTo, `The sign-in provider refused the request (${refusal}).`);
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        redirectToSignIn(response, pending.returnTo, "The sign-in provider returned no authorization code.");
        return;
      }

      let identity;
      try {
        identity = await oidc.identify({
          code,
          redirectUri: pending.redirectUri,
          verifier: pending.verifier,
          nonce: pending.nonce,
        });
      } catch (error) {
        redirectToSignIn(response, pending.returnTo, oidcMessage(error));
        return;
      }

      let signedIn: User;
      try {
        signedIn = await signInWithIdentity(identity, pending.invite, oidcConfig);
      } catch (error) {
        if (error instanceof HttpError) {
          redirectToSignIn(response, pending.returnTo, error.message);
          return;
        }
        throw error;
      }
      setSession(response, signedIn.id);
      response.statusCode = 302;
      response.setHeader("Location", pending.returnTo);
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/logout") {
      if (context.sessionToken) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(context.sessionToken));
      clearSession(response);
      json(response, 200, { ok: true });
      return;
    }

    /*
     * Setting the provider up, from a screen rather than from a redeploy.
     *
     * All three are the installation admin's, not a project owner's: there is one provider
     * for the whole installation, the way there is one admin, and a project owner reshaping
     * their own board has no business deciding how everybody signs in to all of them.
     */
    if (method === "GET" && url.pathname === "/api/auth/oidc/settings") {
      const user = requireAdmin(context);
      void user;
      json(response, 200, {
        settings: oidcSettingsView(database, environmentOidc, oidcRedirectUri(request, url, null)),
      });
      return;
    }

    if (method === "PATCH" && url.pathname === "/api/auth/oidc/settings") {
      const user = requireAdmin(context);
      if (environmentOidc) {
        throw new HttpError(409, "This provider is set in the environment, so it is changed there.");
      }
      const input = oidcSettingsSchema.parse(await readJson(request));
      if (input.issuer !== undefined && input.issuer !== "") {
        const parsed = parseIssuerInput(input.issuer);
        if ("error" in parsed) throw new HttpError(400, `The provider address ${parsed.error}`);
      }
      saveOidcSettings(database, input, user.id);
      audit(context, {
        projectId: defaultProjectIdForUser(database, user) ?? "",
        entityType: "member",
        entityId: user.id,
        entityTitle: "single sign-on",
        action: "updated",
      });
      json(response, 200, {
        settings: oidcSettingsView(database, environmentOidc, oidcRedirectUri(request, url, null)),
      });
      return;
    }

    /*
     * Ask a provider to describe itself, before anything is saved.
     *
     * This is the auto-populate button and the check button at once: the same call fills the
     * screen in and says whether the address works. It answers about the provider, never about
     * the client id and secret, because nothing short of an actual sign-in exercises those -
     * and a check that implied otherwise would be worse than no check.
     */
    if (method === "POST" && url.pathname === "/api/auth/oidc/probe") {
      requireAdmin(context);
      const input = oidcProbeSchema.parse(await readJson(request));
      const parsed = parseIssuerInput(input.issuer);
      if ("error" in parsed) throw new HttpError(400, `The provider address ${parsed.error}`);
      const probe = oidcProviders.probe({
        issuer: parsed.issuer,
        clientId: input.clientId ?? "grimoire",
        clientSecret: "",
        redirectUri: null,
        scopes: DEFAULT_OIDC_SCOPES,
        label: parsed.hostname,
        autoRegister: true,
        allowedEmailDomains: [],
        signupProject: null,
      });
      try {
        json(response, 200, { provider: await probe.describe() });
      } catch (error) {
        if (error instanceof OidcError) {
          json(response, 200, { error: error.message });
          return;
        }
        console.error("oidc probe failed", error);
        json(response, 200, { error: "That address could not be reached from the server." });
      }
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
      // Resolved before the reply goes out: requireProject can refuse, and a refusal
      // after json() has answered is a success the client saw and a 500 in the log
      // that nothing can be correlated with.
      const projectId = requireProject(context, user);
      const input = displayNameSchema.parse(await readJson(request));
      database.prepare("UPDATE users SET name = ? WHERE id = ?").run(input.name, user.id);
      const updated = withAvatar(publicUser(findUserById(database, user.id)!));
      json(response, 200, { user: updated });
      // Names are joined in at read time, so every card byline, idea, and member face is stale.
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    if (method === "PUT" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const data = await readRaw(request, AVATAR_SIZE_LIMIT);
      const imageType = sniffAvatarType(data);
      if (!imageType) throw new HttpError(400, "Profile picture must be a PNG, JPEG, or WebP image");
      avatarStore.save(user.id, data, imageType);
      json(response, 200, { avatarUrl: avatarStore.urlFor(user.id) });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && url.pathname === "/api/account/avatar") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      avatarStore.remove(user.id);
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const avatarMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)$/);
    if (method === "GET" && avatarMatch) {
      requireUser(context);
      if (!/^[0-9a-f-]{36}$/i.test(avatarMatch[1]!)) throw new HttpError(404, "Profile picture not found");
      const avatar = avatarStore.get(avatarMatch[1]!);
      if (!avatar) throw new HttpError(404, "Profile picture not found");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      sendFile(response, avatar.path, avatar.contentType);
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
        imageName = decodeURIComponent(imageMatch[1]!);
      } catch {
        throw new HttpError(404, "Image not found");
      }
      const image = slug ? imageStore.get(slug, imageName) : null;
      if (!image) throw new HttpError(404, "Image not found");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      sendFile(response, image.path, image.contentType);
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
      auditAs(user, { projectId, entityType: "member", entityId: userId, entityTitle: user.name, action: "joined" });
      setSession(response, userId);
      json(response, 201, { user });
      broadcast(projectId, "work", null);
      return;
    }

    if (method === "GET" && url.pathname === "/api/github/pulls") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const config = projectGithubConfig(database, projectId);
      const pulls = await listOpenPullRequests(options.githubFetcher ?? githubApiFetcher, config.repo, config.token);
      json(response, 200, { pulls });
      return;
    }

    const recapMatch = url.pathname.match(/^\/api\/chapters\/([^/]+)\/recap$/);
    if (method === "GET" && recapMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      requireChaptersEnabled(projectId);
      const recap = recapFor(projectId, recapMatch[1]!);
      if (!recap) throw new HttpError(404, "Chapter not found");
      json(response, 200, { recap });
      return;
    }

    if (method === "POST" && recapMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can post a recap");
      requireChaptersEnabled(projectId);
      await readJson(request);
      const result = await sendRecap(projectId, recapMatch[1]!);
      if (result === "not_found") throw new HttpError(404, "Chapter not found");
      if (result === "no_webhook") throw new HttpError(400, "This project has no Discord webhook to post to");
      json(response, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/github/verify") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can check the GitHub connection");
      await readJson(request);
      const config = projectGithubConfig(database, projectId);
      const verdict = await verifyRepoAccess(options.githubFetcher ?? githubApiFetcher, config.repo, config.token);
      json(response, 200, verdict);
      return;
    }

    if (method === "POST" && url.pathname === "/api/github/refresh") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      await readJson(request);
      await runGithubSync(projectId);
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "POST" && url.pathname === "/api/invites") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the project owner can create invitations");
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
      audit(context, { projectId, entityType: "member", entityId: null, entityTitle: "invitation link", action: "invited" });
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
      // Anyone signed in may start a project, and `createProject` writes them in as its
      // owner. Reserving this for a single account is what left ownership nowhere to live
      // but the installation: there was nobody else a project could belong to.
      const input = projectSchema.parse(await readJson(request));
      const projectId = createProject(database, user.id, input.name);
      audit(context, { projectId, entityType: "project", entityId: projectId, entityTitle: input.name, action: "created" });
      json(response, 201, { project: { id: projectId, name: input.name } });
      return;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "PATCH" && projectMatch) {
      const user = requireUser(context);
      requireProjectMembership(user, projectMatch[1]!);
      if (!userOwnsProject(database, user, projectMatch[1]!)) {
        throw new HttpError(403, "Only the owner can change project settings");
      }
      const input = projectUpdateSchema.parse(await readJson(request));
      const projectId = projectMatch[1]!;
      const before = projectById(database, projectId);
      if (!before) throw new HttpError(404, "Project not found");
      const previousName = String(before.name);
      const changes: Array<{ field: string; from: string | null; to: string | null }> = [];

      if (input.name !== undefined && input.name !== previousName) {
        if (!renameProject(database, projectId, input.name)) throw new HttpError(404, "Project not found");
        changes.push({ field: "name", from: previousName, to: input.name });
      }
      if (input.description !== undefined) {
        const previousDescription = String(before.description ?? "");
        if (input.description !== previousDescription) {
          if (!setProjectDescription(database, projectId, input.description)) {
            throw new HttpError(404, "Project not found");
          }
          changes.push({
            field: "description",
            from: previousDescription || null,
            to: input.description || null,
          });
        }
      }
      if (input.estimatesEnabled !== undefined) {
        const wasEnabled = estimatesEnabled(database, projectId);
        if (wasEnabled !== input.estimatesEnabled) {
          if (!setEstimatesEnabled(database, projectId, input.estimatesEnabled)) {
            throw new HttpError(404, "Project not found");
          }
          changes.push({
            field: "estimates",
            from: wasEnabled ? "on" : "off",
            to: input.estimatesEnabled ? "on" : "off",
          });
        }
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

      if (input.discordWebhook !== undefined) {
        // The log records that a destination changed, never what it is.
        const had = projectRecapConfig(database, projectId).webhook !== "";
        setProjectRecap(database, projectId, { webhook: input.discordWebhook });
        const has = input.discordWebhook !== "";
        if (had !== has) {
          changes.push({ field: "discord webhook", from: had ? "set" : null, to: has ? "set" : null });
        }
      }
      if (input.recapOnClose !== undefined) {
        const was = projectRecapConfig(database, projectId).onClose;
        if (was !== input.recapOnClose) {
          setProjectRecap(database, projectId, { onClose: input.recapOnClose });
          changes.push({ field: "recap on close", from: was ? "on" : "off", to: input.recapOnClose ? "on" : "off" });
        }
      }
      if (input.githubRepo !== undefined) {
        const previousRepo = projectGithubConfig(database, projectId).repo;
        const nextRepo = normalizeRepo(input.githubRepo);
        if (nextRepo !== previousRepo) {
          setProjectGithub(database, projectId, { repo: nextRepo });
          changes.push({ field: "github repository", from: previousRepo || null, to: nextRepo || null });
        }
      }
      if (input.githubToken !== undefined) {
        // The log records that a token changed hands, never what it was.
        const hadToken = projectGithubConfig(database, projectId).token !== "";
        setProjectGithub(database, projectId, { token: input.githubToken });
        const hasToken = input.githubToken !== "";
        if (hadToken !== hasToken) {
          changes.push({ field: "github token", from: hadToken ? "set" : null, to: hasToken ? "set" : null });
        }
      }

      const name = input.name ?? previousName;
      if (changes.length > 0) {
        audit(context, {
          projectId,
          entityType: "project",
          entityId: projectId,
          entityTitle: name,
          action: changes.some((change) => change.field === "name") ? "renamed" : "updated",
          changes,
        });
      }
      const githubAfter = projectGithubConfig(database, projectId);
      json(response, 200, {
        project: {
          id: projectId,
          name,
          description: String(projectById(database, projectId)?.description ?? ""),
          chaptersEnabled: chaptersEnabled(database, projectId),
          estimatesEnabled: estimatesEnabled(database, projectId),
          discordWebhookSet: projectRecapConfig(database, projectId).webhook !== "",
          recapOnClose: projectRecapConfig(database, projectId).onClose,
          githubRepo: githubAfter.repo,
          githubTokenSet: githubAfter.token !== "",
        },
      });
      // A freshly pointed-at repository answers now rather than on the next poll, and the
      // list of open pull requests is asked again rather than served from the old answer.
      if (input.githubRepo !== undefined || input.githubToken !== undefined) {
        forgetOpenPullRequests(githubAfter.repo);
      }
      if (githubAfter.repo) void runGithubSync(projectId);
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    // The restore list and the restore itself are owner surfaces, like archiving is. Restoring
    // only clears `archived_at`: the pages never left the disk, so nothing else moves.
    if (method === "GET" && url.pathname === "/api/projects/archived") {
      const user = requireUser(context);
      // Exactly the projects the next route would let them restore, so the list never offers
      // a button that is going to be refused.
      json(response, 200, { projects: listArchivedProjects(database, user) });
      return;
    }

    const projectRestoreMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/restore$/);
    if (method === "POST" && projectRestoreMatch) {
      const user = requireUser(context);
      // Ownership is read off the membership row, which outlives archiving - so this is asked
      // directly rather than through the live-project check, which refuses anything archived.
      if (!userOwnsProject(database, user, projectRestoreMatch[1]!)) {
        throw new HttpError(404, "Archived project not found");
      }
      await readJson(request);
      const restoredName = projectById(database, projectRestoreMatch[1]!)?.name;
      if (!restoreProject(database, projectRestoreMatch[1]!)) {
        throw new HttpError(404, "Archived project not found");
      }
      audit(context, {
        projectId: projectRestoreMatch[1]!,
        entityType: "project",
        entityId: projectRestoreMatch[1]!,
        entityTitle: String(restoredName ?? "project"),
        action: "restored",
      });
      json(response, 200, { ok: true });
      broadcast(projectRestoreMatch[1]!, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && projectMatch) {
      const user = requireUser(context);
      requireProjectMembership(user, projectMatch[1]!);
      if (!userOwnsProject(database, user, projectMatch[1]!)) {
        throw new HttpError(403, "Only the owner can archive projects");
      }
      await readJson(request);
      const archivedName = projectById(database, projectMatch[1]!)?.name;
      const result = archiveProject(database, projectMatch[1]!);
      if (result === "not_found") throw new HttpError(404, "Project not found");
      if (result === "last_project") throw new HttpError(409, "The last project cannot be archived");
      audit(context, {
        projectId: projectMatch[1]!,
        entityType: "project",
        entityId: projectMatch[1]!,
        entityTitle: String(archivedName ?? "project"),
        action: "archived",
      });
      json(response, 200, { ok: true });
      broadcast(projectMatch[1]!, "work", requestClientId(request));
      return;
    }

    // Agent access. Issuing a credential is the owner deciding something may write on their
    // behalf, so an agent can never reach these at all: a token that could mint another
    // token would make revocation meaningless.
    if (method === "GET" && url.pathname === "/api/agent-tokens") {
      const user = requireUser(context);
      const listing = requireProjectOwner(context, user, "Only the owner can manage agent access");
      json(response, 200, { tokens: listAgentTokens(database, listing) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/agent-tokens") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage agent access");
      const input = agentTokenCreateSchema.parse(await readJson(request));
      const issued = issueAgentToken(database, {
        projectId,
        userId: user.id,
        name: input.name,
        scope: input.scope,
        expiresAt: input.expiresAt ?? null,
      });
      if (!issued) throw new HttpError(404, "Project not found");
      // Recorded as its own entity type: borrowing "project" here would make the digest
      // tell every member the owner created or removed a project, which is exactly the
      // alarming-and-untrue phrasing the digest copy was written to avoid.
      audit(context, {
        projectId,
        entityType: "agent",
        entityId: issued.token.id,
        entityTitle: input.name,
        action: "created",
        changes: [{ field: "scope", from: null, to: input.scope === "write" ? "read and write" : "read only" }],
      });
      // The only time the secret leaves the server. Nothing stores it but the holder.
      json(response, 201, { token: issued.token, secret: issued.secret });
      return;
    }

    const agentTokenMatch = url.pathname.match(/^\/api\/agent-tokens\/([^/]+)$/);
    if (method === "DELETE" && agentTokenMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage agent access");
      const revoked = listAgentTokens(database, projectId).find((token) => token.id === agentTokenMatch[1]!);
      if (!revokeAgentToken(database, projectId, agentTokenMatch[1]!)) {
        throw new HttpError(404, "Agent token not found");
      }
      writeLimiter.forget(agentTokenMatch[1]!);
      audit(context, {
        projectId,
        entityType: "agent",
        entityId: agentTokenMatch[1]!,
        entityTitle: revoked?.name ?? "an agent",
        action: "removed",
      });
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/categories") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage categories");
      const input = categoryCreateSchema.parse(await readJson(request));
      const result = createCategory(database, projectId, input);
      if (result === "invalid_name") throw new HttpError(400, "The category needs a name with letters or numbers");
      if (result === "exists") throw new HttpError(409, "A category with this name already exists");
      audit(context, {
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
      const projectId = requireProjectOwner(context, user, "Only the owner can manage categories");
      const input = categoryUpdateSchema.parse(await readJson(request));
      const previous = categoriesForProject(database, projectId).find((value) => value.slug === categoryMatch[1]!);
      const category = updateCategory(database, projectId, categoryMatch[1]!, input);
      if (!category) throw new HttpError(404, "Category not found");
      const categoryEdits = previous
        ? [
          ...(previous.name === category.name ? [] : [{ field: "name", from: previous.name, to: category.name }]),
          ...(previous.color === category.color ? [] : [{ field: "color", from: previous.color, to: category.color }]),
        ]
        : [];
      if (categoryEdits.length > 0) {
        audit(context, {
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
      const projectId = requireProjectOwner(context, user, "Only the owner can manage categories");
      const removed = categoriesForProject(database, projectId).find((value) => value.slug === categoryMatch[1]!);
      if (!deleteCategory(database, pageStore, projectId, categoryMatch[1]!)) {
        throw new HttpError(404, "Category not found");
      }
      audit(context, {
        projectId,
        entityType: "category",
        entityId: categoryMatch[1]!,
        entityTitle: removed?.name ?? categoryMatch[1]!,
        action: "deleted",
      });
      json(response, 200, { ok: true });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    // Defining a field is deciding what the project records about its work, which is the same
    // kind of decision as adding a column would be. An agent fills fields in; it never
    // decides which exist, so these are owner-only and outside the agent allow list.
    if (method === "POST" && url.pathname === "/api/fields") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only an owner can manage fields");
      const input = fieldCreateSchema.parse(await readJson(request));
      const result = createField(database, projectId, input);
      if (result === "invalid_label") throw new HttpError(400, "The field needs a name with letters or numbers");
      if (result === "needs_options") throw new HttpError(400, "A choice field needs at least one option");
      if (result === "exists") throw new HttpError(409, "A field with this name already exists");
      audit(context, {
        projectId,
        entityType: "field",
        entityId: result.field.key,
        entityTitle: result.field.label,
        action: "created",
        changes: [{ field: "type", from: null, to: result.field.type }],
      });
      json(response, 201, { field: result.field });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const fieldMatch = url.pathname.match(/^\/api\/fields\/([^/]+)$/);
    if (method === "PATCH" && fieldMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only an owner can manage fields");
      const input = fieldUpdateSchema.parse(await readJson(request));
      const before = fieldsForProject(database, projectId).find((field) => field.key === fieldMatch[1]!);
      const result = updateField(database, pageStore, projectId, fieldMatch[1]!, input);
      if (result === "not_found") throw new HttpError(404, "Field not found");
      if (result === "needs_options") throw new HttpError(400, "A choice field needs at least one option");
      if (result === "type_locked") {
        throw new HttpError(400, "A field can only change type between the two kinds of choice");
      }
      const edits = before
        ? [
          ...(before.label === result.field.label ? [] : [{ field: "name", from: before.label, to: result.field.label }]),
          ...(before.type === result.field.type ? [] : [{ field: "type", from: before.type, to: result.field.type }]),
          ...(before.options.join(", ") === result.field.options.join(", ")
            ? []
            : [{ field: "options", from: before.options.join(", "), to: result.field.options.join(", ") }]),
          ...(before.showOnTile === result.field.showOnTile
            ? []
            : [{ field: "on tiles", from: before.showOnTile ? "yes" : "no", to: result.field.showOnTile ? "yes" : "no" }]),
          // Said out loud, because withdrawing an option silently emptied pages nobody touched.
          ...(result.cleared > 0 ? [{ field: "pages cleared", from: null, to: String(result.cleared) }] : []),
        ]
        : [];
      if (edits.length > 0) {
        audit(context, {
          projectId,
          entityType: "field",
          entityId: result.field.key,
          entityTitle: result.field.label,
          action: "updated",
          changes: edits,
        });
      }
      json(response, 200, { field: result.field, cleared: result.cleared });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && fieldMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only an owner can manage fields");
      const removed = fieldsForProject(database, projectId).find((field) => field.key === fieldMatch[1]!);
      const cleared = deleteField(database, pageStore, projectId, fieldMatch[1]!);
      if (cleared === null) throw new HttpError(404, "Field not found");
      audit(context, {
        projectId,
        entityType: "field",
        entityId: fieldMatch[1]!,
        entityTitle: removed?.label ?? fieldMatch[1]!,
        action: "deleted",
        changes: cleared > 0 ? [{ field: "pages cleared", from: null, to: String(cleared) }] : [],
      });
      json(response, 200, { ok: true, cleared });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "POST" && url.pathname === "/api/chapters") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage chapters");
      requireChaptersEnabled(projectId);
      const input = chapterCreateSchema.parse(await readJson(request));
      const result = createChapter(database, chapterStore, projectId, user.id, input);
      if (!result) throw new HttpError(404, "Project not found");
      if (result === "invalid_name") throw new HttpError(400, "The chapter needs a name with letters or numbers");
      if (result === "exists") throw new HttpError(409, "A chapter with this name already exists");
      if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
      audit(context, {
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
      const projectId = requireProjectOwner(context, user, "Only the owner can manage chapters");
      requireChaptersEnabled(projectId);
      const input = chapterUpdateSchema.parse(await readJson(request));
      const before = chaptersForProject(database, chapterStore, projectId)
        .find((chapter) => chapter.slug === chapterMatch[1]!);
      const result = updateChapter(database, chapterStore, projectId, chapterMatch[1]!, input);
      if (!result) throw new HttpError(404, "Project not found");
      if (result === "not_found") throw new HttpError(404, "Chapter not found");
      if (result === "already_open") throw new HttpError(409, ALREADY_OPEN_MESSAGE);
      const changes = before ? chapterChanges(before, result.chapter) : [];
      if (changes.length > 0) {
        audit(context, {
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

    const chapterCloseMatch = url.pathname.match(/^\/api\/chapters\/([^/]+)\/close$/);
    if (method === "POST" && chapterCloseMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage chapters");
      requireChaptersEnabled(projectId);
      const input = chapterCloseSchema.parse(await readJson(request));
      const slug = chapterCloseMatch[1]!;
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

      const carriedWord = result.carried.pages === 0
        ? "nothing unfinished"
        : `${result.carried.pages} page${result.carried.pages === 1 ? "" : "s"}${
          result.carried.estimate > 0 ? ` (${result.carried.estimate})` : ""
        }`;
      audit(context, {
        projectId,
        entityType: "chapter",
        entityId: slug,
        entityTitle: result.chapter.name,
        action: "updated",
        changes: [
          { field: "state", from: CHAPTER_STATE_LABELS[before?.state ?? "open"], to: CHAPTER_STATE_LABELS.closed },
          {
            field: "carried over",
            from: null,
            to: carryTo === undefined || result.carried.pages === 0
              ? carriedWord
              : `${carriedWord} to ${carryTo ?? "no chapter"}`,
          },
        ],
      });
      json(response, 200, { chapter: result.chapter, carried: result.carried });
      broadcast(projectId, "work", requestClientId(request));
      /*
       * The recap goes out after the answer, not before it: a Discord outage must never be
       * the reason a chapter fails to close. Whatever happens to the post, the close already
       * happened and the board already knows.
       */
      if (projectRecapConfig(database, projectId).onClose) {
        void sendRecap(projectId, slug).catch((error) => console.error("recap post failed", error));
      }
      return;
    }

    if (method === "DELETE" && chapterMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the owner can manage chapters");
      requireChaptersEnabled(projectId);
      const removed = chaptersForProject(database, chapterStore, projectId)
        .find((chapter) => chapter.slug === chapterMatch[1]!);
      const released = pagesInChapter(database, pageStore, projectId, chapterMatch[1]!);
      if (!deleteChapter(database, pageStore, chapterStore, projectId, chapterMatch[1]!)) {
        throw new HttpError(404, "Chapter not found");
      }
      audit(context, {
        projectId,
        entityType: "chapter",
        entityId: chapterMatch[1]!,
        entityTitle: removed?.name ?? chapterMatch[1]!,
        action: "deleted",
        changes: released > 0 ? [{ field: "pages released", from: null, to: String(released) }] : [],
      });
      json(response, 200, { ok: true, released });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "POST" && url.pathname === "/api/members") {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only the project owner can add people");
      const input = memberAddSchema.parse(await readJson(request));
      const result = addProjectMember(database, projectId, input.email);
      /*
       * Saying which of the two went wrong tells an owner whether an account exists at that
       * address. On an installation nobody can register on without an invitation, and to a
       * caller who already owns a project here, that is not a fact worth withholding - and
       * withholding it would leave a typo and an existing member looking identical.
       */
      if (result === "no_account") throw new HttpError(404, "Nobody here uses that email address");
      if (result === "already_there") throw new HttpError(409, "They are already on this project");
      audit(context, {
        projectId,
        entityType: "member",
        entityId: result.added.id,
        entityTitle: result.added.name,
        action: "joined",
      });
      json(response, 201, { members: membersForProject(database, projectId).map(withAvatar) });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
    if (method === "PATCH" && memberMatch) {
      const user = requireUser(context);
      const projectId = requireProjectOwner(context, user, "Only an owner can change roles");
      const input = memberRoleSchema.parse(await readJson(request));
      // Changing your own role is refused rather than guarded, because the only case worth
      // allowing is the one that strands the project: its sole owner demoting themselves
      // leaves nobody who can ever promote anyone again. A second owner exists to be asked.
      if (memberMatch[1]! === user.id) throw new HttpError(409, "Ask another owner to change your own role");
      const member = membersForProject(database, projectId).find((value) => value.id === memberMatch[1]!);
      const result = setMemberRole(database, projectId, memberMatch[1]!, input.role);
      if (result === "not_found") throw new HttpError(404, "Member not found");
      // The admin is the installation's, not this project's, so no project role may replace it.
      if (result === "admin") throw new HttpError(409, "The admin's role cannot be changed");
      if (result === "updated" && member) {
        audit(context, {
          projectId,
          entityType: "member",
          entityId: memberMatch[1]!,
          entityTitle: member.name,
          action: "updated",
          // The membership row is the only thing that moved, and it is what this project's
          // log speaks for, so it is the role the entry reports from and to.
          changes: [{ field: "role", from: member.projectRole, to: input.role }],
        });
      }
      json(response, 200, { members: membersForProject(database, projectId).map(withAvatar) });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && memberMatch) {
      const user = requireUser(context);
      await readJson(request);
      const projectId = requireProjectOwner(context, user, "Only the project owner can remove members");
      const removedMember = membersForProject(database, projectId).find((value) => value.id === memberMatch[1]!);
      const result = removeProjectMember(database, pageStore, projectId, memberMatch[1]!);
      if (result === "owner") throw new HttpError(409, "The project owner cannot be removed");
      if (result === "admin") throw new HttpError(409, "The admin cannot be removed");
      if (result === "not_found") throw new HttpError(404, "Member not found");
      audit(context, {
        projectId,
        entityType: "member",
        entityId: memberMatch[1]!,
        entityTitle: removedMember?.name ?? "a member",
        action: "removed",
      });
      disconnectUserEvents(memberMatch[1]!);
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
        keepAlive: setInterval(() => sendEvent(client, ": keepalive\n\n"), 25_000),
        userId: user.id,
      };
      eventClients.add(client);
      broadcastPresence(projectId);
      // A dead socket reports itself as a stream 'error', and an 'error' with no
      // listener is an uncaught exception - so the listener is attached the moment
      // the stream exists, not left to the next write to discover.
      response.on("error", () => dropEventClient(client));
      response.once("close", () => dropEventClient(client));
      return;
    }

    if (method === "GET" && url.pathname === "/api/activity") {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const entity = url.searchParams.get("entity");
      if (entity && !/^[0-9a-z-]{1,64}$/i.test(entity)) throw new HttpError(400, "Invalid activity filter");
      // The project-wide history is the owner's tool; per-entity history stays
      // available to every member because the page dialog shows it inline.
      if (!entity && !userOwnsProject(database, user, projectId)) {
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
        // The project list exists for the switcher, and a token cannot switch. Sending the
        // issuer's other projects to a credential pinned to one of them would name things
        // the credential has no business knowing exist.
        projects: context.agent
          ? board.projects.filter((candidate) => candidate.id === board.project.id)
          : board.projects,
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
      audit(context, {
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
      audit(context, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action: "created" });
      json(response, 201, { idea });
      broadcast(projectId, "ideas", requestClientId(request));
      return;
    }

    const promotionMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)\/promote$/);
    if (method === "POST" && promotionMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      await readJson(request);
      const source = findIdea(database, ideaStore, projectId, promotionMatch[1]!);
      const page = promoteIdea(
        database,
        pageStore,
        chapterStore,
        ideaStore,
        projectId,
        user.id,
        promotionMatch[1]!,
      );
      if (!page) throw new HttpError(404, "Idea not found");
      audit(context, {
        projectId,
        entityType: "idea",
        entityId: promotionMatch[1]!,
        entityTitle: source?.title ?? page.title,
        action: "promoted",
        changes: [{ field: "became a page", from: null, to: page.title }],
      });
      audit(context, {
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
      const idea = undoPromotion(database, pageStore, ideaStore, projectId, promotionUndoMatch[1]!);
      if (!idea) throw new HttpError(404, "Promoted idea not found");
      audit(context, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action: "restored" });
      json(response, 200, { idea });
      broadcast(projectId, "both", requestClientId(request));
      return;
    }

    const ideaMatch = url.pathname.match(/^\/api\/ideas\/([^/]+)$/);
    if (method === "PATCH" && ideaMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const previousIdea = findIdea(database, ideaStore, projectId, ideaMatch[1]!);
      const idea = updateIdea(
        database,
        ideaStore,
        projectId,
        ideaMatch[1]!,
        ideaUpdateSchema.parse(await readJson(request)),
      );
      if (!idea) throw new HttpError(404, "Idea not found");
      if (previousIdea) {
        const changes = ideaChanges(previousIdea, idea);
        const action = changeAction(changes);
        // Reranking the shortlist changes nothing a reader would look for.
        if (action) {
          audit(context, { projectId, entityType: "idea", entityId: idea.id, entityTitle: idea.title, action, changes });
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
      const page = restorePage(database, pageStore, projectId, pageRestoreMatch[1]!);
      if (!page) throw new HttpError(404, "Archived page not found");
      audit(context, { projectId, entityType: "page", entityId: page.id, entityTitle: page.title, action: "restored" });
      json(response, 200, { page });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    /*
     * The conversation beside a page.
     *
     * Separate from the history on purpose: history is derived and belongs to nobody, while a
     * thread is addressed to somebody and is finished only once it has been answered. Reading
     * is open to every member, exactly as the per-page history is.
     */
    const discussionMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/discussion$/);
    if (method === "GET" && discussionMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, discussionMatch[1]!);
      if (!page) throw new HttpError(404, "Page not found");
      json(response, 200, { threads: listDiscussion(database, projectId, page.id) });
      return;
    }

    if (method === "POST" && discussionMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, discussionMatch[1]!);
      if (!page) throw new HttpError(404, "Page not found");
      const { body } = discussionBodySchema.parse(await readJson(request));
      // Resolved here, against the people actually on this project, so a name that belongs to
      // nobody stays plain text rather than becoming a mention of somebody else.
      const thread = openThread(
        database,
        projectId,
        page.id,
        { id: user.id, name: user.name, agentTokenId: agentTokenId(context) },
        body,
        parseMentions(body, membersForProject(database, projectId)),
      );
      audit(context, {
        projectId,
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "asked",
        changes: [{ field: "said", from: null, to: summarize(body) }],
      });
      json(response, 201, { thread });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    /*
     * "I have looked at this."
     *
     * Written when somebody opens the column, which is the only moment they can be said to
     * have read it. Private to them, like every other seen marker here: nobody learns how
     * caught up anybody else is.
     */
    const seenMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/discussion\/seen$/);
    if (method === "POST" && seenMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, seenMatch[1]!);
      if (!page) throw new HttpError(404, "Page not found");
      await readJson(request);
      markDiscussionSeen(database, projectId, page.id, user.id);
      json(response, 200, { ok: true });
      return;
    }

    const replyMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/discussion\/([^/]+)\/replies$/);
    if (method === "POST" && replyMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, replyMatch[1]!);
      if (!page) throw new HttpError(404, "Page not found");
      const { body } = discussionBodySchema.parse(await readJson(request));
      const thread = replyToThread(
        database,
        projectId,
        page.id,
        replyMatch[2]!,
        { id: user.id, name: user.name, agentTokenId: agentTokenId(context) },
        body,
        parseMentions(body, membersForProject(database, projectId)),
      );
      if (thread === "no_thread") throw new HttpError(404, "Thread not found");
      if (thread === "answered") {
        throw new HttpError(409, "That question has been answered. Open a new thread to say something else.");
      }
      audit(context, {
        projectId,
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "replied",
        changes: [{ field: "said", from: null, to: summarize(body) }],
      });
      json(response, 201, { thread });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    /*
     * Closing a thread is a judgement that a question has been answered, which is a person's
     * call - agentMayReach refuses this route to every credential, whatever its scope. An
     * agent that could close its own thread could mark its own work reviewed.
     */
    const answeredMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/discussion\/([^/]+)\/answered$/);
    if (method === "POST" && answeredMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, answeredMatch[1]!);
      if (!page) throw new HttpError(404, "Page not found");
      const { answered } = discussionAnswerSchema.parse(await readJson(request));
      const result = setThreadAnswered(database, projectId, page.id, answeredMatch[2]!, answered, user.id);
      if (result === "no_thread") throw new HttpError(404, "Thread not found");
      // Asking for the state it already holds is a no-op rather than a second log line.
      if (result !== "unchanged") {
        audit(context, {
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
      const thread = result === "unchanged" ? findThread(database, projectId, page.id, answeredMatch[2]!) : result;
      if (!thread) throw new HttpError(404, "Thread not found");
      json(response, 200, { thread });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (method === "GET" && pageMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const page = findPage(database, pageStore, projectId, pageMatch[1]!);
      // Archived pages answer 404 here rather than being served read-only, because the board
      // has no place to put one and search is the documented way back to the archive.
      if (!page) throw new HttpError(404, "Page not found");
      json(response, 200, { page });
      return;
    }

    if (method === "PATCH" && pageMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const labels = labelsForProject(projectId);
      const before = findPage(database, pageStore, projectId, pageMatch[1]!);
      const { github: githubRaw, ...input } = pageUpdateSchema.parse(await readJson(request));
      if (input.chapter) requireChaptersEnabled(projectId);
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
      const page = updatePage(database, pageStore, chapterStore, projectId, pageMatch[1]!, {
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
        await runGithubSync(projectId);
        settled = findPage(database, pageStore, projectId, page.id) ?? page;
      }
      if (before) {
        // The diff is what this request asked for; a move the automation made on top of it
        // is the automation's to record, under its own name.
        const changes = pageChanges(before, page, labels);
        const action = changeAction(changes);
        // Reordering inside one column changes nothing a reader would look for.
        if (action) {
          audit(context, { projectId, entityType: "page", entityId: page.id, entityTitle: page.title, action, changes });
        }
      }
      json(response, 200, { page: settled });
      broadcast(projectId, "work", requestClientId(request));
      return;
    }

    if (method === "DELETE" && pageMatch) {
      const user = requireUser(context);
      const projectId = requireProject(context, user);
      const archived = findPage(database, pageStore, projectId, pageMatch[1]!);
      if (!archivePage(database, pageStore, projectId, pageMatch[1]!)) {
        throw new HttpError(404, "Page not found");
      }
      audit(context, {
        projectId,
        entityType: "page",
        entityId: pageMatch[1]!,
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

  /**
   * Records an event for the person a request is acting as, and the agent that acted.
   *
   * Taking the whole context rather than a user is deliberate: the agent travels with the
   * request, so a call site cannot forget to attribute a machine write and quietly make it
   * look like a person did it.
   */
  function audit(context: RequestContext, input: Omit<RecordAuditInput, "actor">): void {
    auditAs(requireUser(context), input, agentTokenId(context));
  }

  /** For the few writes that happen before the acting user has a request context at all. */
  function auditAs(user: User, input: Omit<RecordAuditInput, "actor">, tokenId: string | null = null): void {
    recordAuditEvent(database, {
      ...input,
      actor: { id: user.id, name: user.name },
      agentTokenId: tokenId,
    });
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
    let fields: Map<string, string> | null = null;
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
      fieldLabel: (key) => {
        fields ??= new Map(fieldsForProject(database, projectId).map((value) => [value.key, value.label]));
        return fields.get(key) ?? key;
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

  /**
   * Gates a route that names its project in the URL rather than the header.
   *
   * `requireProject` covers everything that works on "the project I am looking at". These
   * few name one outright - rename it, archive it, restore it - so without this they would
   * act on a project nobody ever put the caller on.
   *
   * It answers 404 rather than 403, so a project someone is not on is indistinguishable
   * from one that does not exist.
   */
  function requireProjectMembership(user: User, projectId: string): void {
    if (!userCanAccessProject(database, user, projectId)) throw new HttpError(404, "Project not found");
  }

  /**
   * Resolves the project being worked on and refuses anyone who may not reshape it.
   *
   * The two questions used to be asked in the wrong order and against the wrong thing: the
   * role was checked first, on the account, before anyone had established which project was
   * even being talked about. Reading the project first is what makes the answer specific to
   * it, which is the whole of this change.
   */
  function requireProjectOwner(context: RequestContext, user: User, refusal: string): string {
    const projectId = requireProject(context, user);
    if (!userOwnsProject(database, user, projectId)) throw new HttpError(403, refusal);
    return projectId;
  }

  function requireProject(context: RequestContext, user: User): string {
    const header = context.request.headers["x-grimoire-project"];
    const fromHeader = typeof header === "string" ? header : header?.[0];
    const requested = (fromHeader ?? context.url.searchParams.get("project") ?? "").slice(0, 100);

    // A token names its own project and can never leave it. The default-project fallback
    // below is a convenience for a browser and a cross-project leak for an agent: a caller
    // that simply forgot the header would otherwise write somewhere else entirely. A
    // mismatch is refused rather than redirected, so the mistake is loud.
    if (context.agent) {
      if (requested && requested !== context.agent.projectId) {
        throw new HttpError(403, "This token cannot act on that project");
      }
      return context.agent.projectId;
    }

    if (requested) {
      if (!userCanAccessProject(database, user, requested)) throw new HttpError(404, "Board not found");
      return requested;
    }
    const fallback = defaultProjectIdForUser(database, user);
    if (!fallback) throw new HttpError(404, "Board not found");
    return fallback;
  }

  /**
   * Reads an `Authorization: Bearer` credential, if the request carries a usable one.
   *
   * Anything malformed, revoked, expired, or belonging to someone who has since left the
   * project resolves to null, which leaves the request simply unauthenticated.
   */
  function agentForBearer(request: IncomingMessage): AgentIdentity | null {
    const header = request.headers.authorization;
    const value = typeof header === "string" ? header : header?.[0];
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (!match) return null;
    return agentForToken(database, match[1]!.trim());
  }

  /**
   * Gates a write, charging it against the token's rate limit.
   *
   * The limiter runs before the scope check so a refused write still spends allowance: a
   * read-only credential hammering a write route is exactly the loop the limiter exists
   * to keep bounded. Reads are deliberately not metered - one query cannot run the disk
   * away, and metering them would punish the orientation read every good agent starts with.
   */
  function requireAgentWrite(context: RequestContext): void {
    if (!context.agent) return;
    if (!writeLimiter.take(context.agent.tokenId)) {
      throw new HttpError(429, "This token is writing too quickly");
    }
    if (context.agent.scope !== "write") throw new HttpError(403, "This token is read-only");
  }

  /** The agent behind a write, so the log can say which one it was. */
  function agentTokenId(context: RequestContext): string | null {
    return context.agent?.tokenId ?? null;
  }

  /**
   * Where the provider sends the browser back to.
   *
   * A provider only ever redirects to a URI registered with it, so deriving this from the
   * request is a convenience rather than a trust decision - a forged Host produces a URI the
   * provider refuses. `GRIMOIRE_OIDC_REDIRECT_URI` pins it for deployments where the public
   * address and the address Grimoire is asked for are not the same string.
   */
  function oidcRedirectUri(request: IncomingMessage, url: URL, config: OidcConfig | null): string {
    if (config?.redirectUri) return config.redirectUri;
    const forwardedProtocol = trustProxy ? String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim() : "";
    const protocol = forwardedProtocol || (options.production ? "https" : url.protocol.replace(":", ""));
    const forwardedHost = trustProxy ? String(request.headers["x-forwarded-host"] ?? "").split(",")[0]!.trim() : "";
    const host = forwardedHost || request.headers.host || url.host;
    return `${protocol}://${host}/api/auth/oidc/callback`;
  }

  /**
   * The account behind a verified identity, matched by email or created.
   *
   * Matching on email is what makes the provider useful on an installation that already has
   * accounts: somebody who has been signing in with a password keeps their history, their
   * memberships and their name the moment single sign-on is turned on. Creating is the narrow
   * case, and it is narrow on purpose - Grimoire is invitation-only, so a provider that
   * vouches for somebody is not by itself a reason to put them on a board. Either they carried
   * an invitation, or the operator has said in configuration that this provider's word is
   * enough.
   */
  async function signInWithIdentity(
    identity: OidcIdentity,
    inviteCode: string | null,
    config: OidcConfig,
  ): Promise<User> {
    // Checked before anything is matched or made, because it is the answer to the one thing
    // auto-registration cannot answer on its own: a provider that is not only your team.
    if (!emailAllowed(identity.email, config.allowedEmailDomains)) {
      throw new HttpError(403, "That email address is not on a domain this Grimoire accepts.");
    }
    /*
     * Who this is, asked in the order that survives people changing their own details.
     *
     * The recorded link comes first. Once somebody has signed in through the provider we know
     * which account they are by the provider's own id for them, and that keeps being true on
     * the day they change their email address - which is precisely the day an email-only match
     * would hand them a second, empty account and lose everything they had done.
     */
    const linked = findOidcLink(database, identity.issuer, identity.subject);
    if (linked) {
      const stored = findUserById(database, linked.userId);
      // The account was removed since it was linked, so the link names nobody. Fall through and
      // treat this as a first sign-in rather than resurrecting a deleted person.
      if (stored) {
        const user = publicUser(stored);
        if (user.email.toLowerCase() !== identity.email) await moveAccountEmail(user, identity.email);
        touchOidcLink(database, identity.issuer, identity.subject);
        return requireOnAProject(findUserById(database, linked.userId)!);
      }
    }

    const existing = findUserByEmail(database, identity.email);
    if (existing) {
      const user = publicUser(existing);
      // The first sign-in after single sign-on is turned on: the address is how somebody's
      // existing account is recognised, and this is the moment that recognition stops having
      // to be repeated. Anything the provider says afterwards is about a known account.
      const claimed = oidcLinkForUser(database, identity.issuer, user.id);
      if (claimed && claimed.subject !== identity.subject) {
        // Two of the provider's people naming one Grimoire account. Refused rather than
        // guessed at, because whichever way it were guessed somebody signs in as somebody else.
        throw new HttpError(409, "Another account at your provider is already signed in to this Grimoire account.");
      }
      linkOidcIdentity(database, identity.issuer, identity.subject, user.id);
      return requireOnAProject(existing);
    }

    const invite = inviteCode ? findUsableInvite(inviteCode) : null;
    const projectId = invite ? String(invite.project_id) : config.autoRegister ? signupProjectId(config) : null;
    if (!projectId) {
      throw new HttpError(
        403,
        config.autoRegister
          ? "There is no project for a new account to join yet."
          : "No Grimoire account uses that email address. Ask the project owner for an invitation link.",
      );
    }

    const userId = randomUUID();
    const now = new Date().toISOString();
    // The account has no password and needs a row that no password can ever match. A hash of
    // something unguessable is used rather than a marker, so a sign-in attempt against this
    // account costs exactly what every other one costs and cannot be told apart by timing.
    const passwordHash = await hashPassword(createOpaqueToken());
    const name = identity.name || identity.email.split("@")[0]!;

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)")
        .run(userId, name, identity.email, passwordHash, now);
      database
        .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
        .run(projectId, userId, now);
      if (invite) {
        const update = database
          .prepare("UPDATE invites SET used_by = ? WHERE id = ? AND used_by IS NULL")
          .run(userId, String(invite.id));
        if (Number(update.changes) !== 1) throw new HttpError(409, "Invitation has already been used");
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    linkOidcIdentity(database, identity.issuer, identity.subject, userId);
    const user = withAvatar(publicUser(findUserById(database, userId)!));
    auditAs(user, { projectId, entityType: "member", entityId: userId, entityTitle: user.name, action: "joined" });
    broadcast(projectId, "work", null);
    return user;
  }

  /** The refusal password sign-in gives too: an account on no project can see nothing. */
  function requireOnAProject(stored: Record<string, string | number | null>): User {
    const user = publicUser(stored);
    if (!defaultProjectIdForUser(database, user)) {
      throw new HttpError(403, "That account is not on any project yet. Ask the project owner to add you.");
    }
    return user;
  }

  /**
   * Follows somebody whose address changed at the provider.
   *
   * This is the whole reason the link is recorded rather than recomputed. The provider is the
   * authority on its own people's addresses, so the account follows - but only into an address
   * nothing else answers to. A collision is two accounts wanting to be one, which is a merge,
   * and a merge is a person's decision about whose history survives rather than a side effect
   * of somebody signing in.
   */
  async function moveAccountEmail(user: User, email: string): Promise<void> {
    const occupied = findUserByEmail(database, email);
    if (occupied && String(occupied.id) !== user.id) {
      throw new HttpError(
        409,
        `Your provider now gives your address as ${email}, which another Grimoire account already uses. An admin has to settle which account is yours.`,
      );
    }
    database.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, user.id);
    const projectId = defaultProjectIdForUser(database, user);
    if (projectId) {
      auditAs({ ...user, email }, {
        projectId,
        entityType: "member",
        entityId: user.id,
        entityTitle: user.name,
        action: "updated",
      });
    }
  }

  /** An invitation that is still worth something: unused, unexpired, and on a live project. */
  function findUsableInvite(code: string): Record<string, string | null> | null {
    const invite = database.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hashToken(code)) as
      | Record<string, string | null>
      | undefined;
    if (!invite || invite.used_by || String(invite.expires_at) <= new Date().toISOString()) return null;
    if (!invite.project_id) return null;
    const project = database
      .prepare("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
      .get(String(invite.project_id));
    return project ? invite : null;
  }

  /** Which project a new account lands on: the one named in configuration, or the first one. */
  function signupProjectId(config: OidcConfig): string | null {
    const named = config.signupProject;
    if (named) {
      const project = database
        .prepare("SELECT id FROM projects WHERE (id = ? OR slug = ?) AND archived_at IS NULL")
        .get(named, named) as { id?: string } | undefined;
      return project?.id ? String(project.id) : null;
    }
    const first = database
      .prepare("SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1")
      .get() as { id?: string } | undefined;
    return first?.id ? String(first.id) : null;
  }

  function setSession(response: ServerResponse, userId: string): void {
    const token = createOpaqueToken();
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_AGE_SECONDS * 1000);
    database
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, hashToken(token), expires.toISOString(), now.toISOString());
    const secure = options.production ? "; Secure" : "";
    appendCookie(
      response,
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secure}`,
    );
  }

  function clearSession(response: ServerResponse): void {
    const secure = options.production ? "; Secure" : "";
    appendCookie(response, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
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

  /**
   * A write to a half-closed stream can throw on the writer's stack, which would
   * turn one dead browser into a failed request - or, from the keep-alive timer,
   * into a dead process. The stream's own death is the disconnect, so the client
   * is dropped and everything else carries on.
   */
  function sendEvent(client: EventClient, message: string): void {
    try {
      client.response.write(message);
    } catch {
      dropEventClient(client);
    }
  }

  function dropEventClient(client: EventClient): void {
    clearInterval(client.keepAlive);
    if (eventClients.delete(client)) broadcastPresence(client.projectId);
  }

  function broadcast(projectId: string, scope: WorkspaceScope, excludedClientId: string | null): void {
    const message = `event: workspace\ndata: ${JSON.stringify({ scope })}\n\n`;
    for (const client of eventClients) {
      if (client.projectId !== projectId || (excludedClientId && client.clientId === excludedClientId)) continue;
      sendEvent(client, message);
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
      sendEvent(client, message);
    }
  }

  function disconnectUserEvents(userId: string): void {
    const affected = new Set<string>();
    for (const client of eventClients) {
      if (client.userId !== userId) continue;
      clearInterval(client.keepAlive);
      eventClients.delete(client);
      affected.add(client.projectId);
      endEventStream(client);
    }
    for (const projectId of affected) broadcastPresence(projectId);
  }

  function endEventStream(client: EventClient): void {
    try {
      client.response.end();
    } catch {
      client.response.destroy();
    }
  }

  function closeEventStreams(): void {
    for (const client of eventClients) {
      clearInterval(client.keepAlive);
      endEventStream(client);
    }
    eventClients.clear();
  }

  return {
    server,
    closeEventStreams,
    close: () => {
      if (databaseClosed) return;
      if (githubPoll) clearInterval(githubPoll);
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

/**
 * The one account that answers for the installation rather than for a project.
 *
 * Whoever set Grimoire up. How everybody signs in is theirs to decide, and deliberately not a
 * project owner's: an owner reshapes their own board, and a provider reaches every board.
 */
function requireAdmin(context: RequestContext): User {
  const user = requireUser(context);
  if (user.role !== "admin") throw new HttpError(403, "Only the Grimoire admin can change how people sign in");
  return user;
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

/**
 * What the page is allowed to load, and from where.
 *
 * The build ships no inline script and Grimoire calls nothing off its own origin, so the
 * script and connection rules are as tight as they go and a bug that injects a `<script>` has
 * nowhere to load it from. Two entries are not tight, and both are deliberate:
 *
 * `style-src` allows inline styles because the interface sets custom properties through the
 * `style` attribute - a category's colour, a field's row count - and the editor's own styles
 * arrive as elements it inserts at runtime. Nonces cannot reach either.
 *
 * `img-src` allows any https source because a page's Markdown may link a picture that lives
 * somewhere else, and refusing those would break boards that already have them. It is a real
 * trade: an external image tells whoever hosts it that somebody here looked at that page.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "worker-src 'none'",
].join("; ");

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

/**
 * Adds a cookie without displacing one already set.
 *
 * A single sign-in writes two: the session it just created, and the expiry of the short-lived
 * state cookie the provider flow used. `setHeader` would keep only the last of them.
 */
function appendCookie(response: ServerResponse, value: string): void {
  const existing = response.getHeader("Set-Cookie");
  const cookies = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  response.setHeader("Set-Cookie", [...cookies, value]);
}

/**
 * Sends a failed provider sign-in back to the interface with something to say.
 *
 * The flow is a browser redirect rather than a fetch, so a JSON refusal would land the person
 * on a page of JSON. The message travels in the query string and the sign-in screen shows it
 * in the same banner a wrong password uses.
 */
function redirectToSignIn(response: ServerResponse, returnTo: string, message: string): void {
  const target = new URL(returnTo, "http://placeholder.invalid");
  target.searchParams.set("signin_error", message);
  response.statusCode = 302;
  response.setHeader("Location", `${target.pathname}${target.search}`);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

/** A provider failure a person can read, without leaking what went wrong internally. */
function oidcMessage(error: unknown): string {
  if (error instanceof OidcError) return error.message;
  console.error("oidc sign-in failed", error);
  return "The sign-in provider could not be reached.";
}

/** Unknown paths fall back to the shell so the client router can answer them. */
function resolveStaticPath(pathname: string, directory: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot name a build file, so the shell answers instead.
  }
  // Containment is asserted on the resolved result rather than proven by stripping
  // prefixes off the input. The old prefix-stripping happened to be safe only because
  // normalize() drops a leading '..' from absolute paths - an invariant nothing stated
  // and nothing checked. Whatever the request spelled, the answer is a file the build
  // directory contains, or the shell.
  const root = resolve(directory);
  const candidate = resolve(root, `.${normalize(`/${decoded}`)}`);
  const contained = candidate === root || candidate.startsWith(root + sep);
  const filePath = contained && candidate !== root ? candidate : join(root, "index.html");
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  const shell = join(root, "index.html");
  return existsSync(shell) ? shell : null;
}

/** The shell is rewritten per request, so it is never stored by a cache or a proxy. */
function serveDocument(response: ServerResponse, filePath: string, preview: LinkPreview | null): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(applyLinkPreview(readFileSync(filePath, "utf8"), preview));
}

/**
 * Streams a file with the failure handled, because a file can vanish between the
 * existence check and the read - and a stream error with no listener is an uncaught
 * exception that takes the whole process down, on a tick the route's error funnel
 * cannot see.
 */
function sendFile(response: ServerResponse, filePath: string, contentType: string): void {
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
    } else {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "File not found" }));
    }
  });
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  stream.pipe(response);
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
  sendFile(response, filePath, contentTypes[extname(filePath)] ?? "application/octet-stream");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
