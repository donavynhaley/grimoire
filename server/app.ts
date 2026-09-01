import { randomUUID } from "node:crypto";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { ZodError } from "zod";
import { PAGE_STATUS_LABELS, type PageStatus, type User } from "../shared/types";
import { agentMayReach } from "./agent-policy";
import { type AgentIdentity, AgentRateLimiter, agentForToken, touchAgentToken } from "./agent-tokens";
import type { EventClient, Options, RequestContext, WorkspaceScope } from "./app-types";
import { type PageLabels, type RecordAuditInput, recordAuditEvent } from "./audit";
import { AvatarStore } from "./avatars";
import { openDatabase, withTransaction } from "./database";
import { githubApiFetcher, syncProjectGithub } from "./github";
import {
  appendCookie,
  applySecurityHeaders,
  HttpError,
  json,
  previewEntityId,
  readCookie,
  resolveStaticPath,
  serveDocument,
  serveFile,
} from "./http";
import { ideaPreview, type LinkPreview, pagePreview } from "./link-preview";
import {
  LOGIN_ACCOUNT_BURST,
  LOGIN_ACCOUNT_PER_MINUTE,
  LOGIN_ADDRESS_BURST,
  LOGIN_ADDRESS_PER_MINUTE,
  LoginRateLimiter,
} from "./login-rate-limit";
import { MarkdownChapterStore } from "./markdown-chapters";
import { MarkdownIdeaStore } from "./markdown-ideas";
import { MarkdownPageStore } from "./markdown-pages";
import { type OidcConfig, type OidcIdentity, oidcHttpFetcher, PendingSignIns } from "./oidc";
import { findOidcLink, linkOidcIdentity, oidcLinkForUser, touchOidcLink } from "./oidc-identities";
import { emailAllowed, OidcProviders, resolveOidc } from "./oidc-settings";
import { ProjectImageStore } from "./project-images";
import { buildRecap, discordPoster, postRecap, recapMessages } from "./recap";
import {
  categoriesForProject,
  chaptersEnabled,
  chaptersForProject,
  defaultProjectIdForUser,
  EditConflictError,
  estimatesEnabled,
  fieldsForProject,
  findUserByEmail,
  findUserById,
  listPages,
  membersForProject,
  PageDependencyError,
  projectById,
  projectRecapConfig,
  publicChapter,
  publicUser,
  userCanAccessProject,
  userOwnsProject,
} from "./repository";
import { activityRoutes } from "./routes/activity";
import { agentReviewRoutes } from "./routes/agent-review";
import { authRoutes } from "./routes/auth";
import { boardRoutes } from "./routes/board";
import { chapterRoutes } from "./routes/chapters";
import { type AppContext, requireUser } from "./routes/context";
import { discussionRoutes } from "./routes/discussion";
import { eventRoutes } from "./routes/events";
import { fileRoutes } from "./routes/files";
import { githubRoutes } from "./routes/github";
import { ideaRoutes } from "./routes/ideas";
import { importRoutes } from "./routes/import";
import { memberRoutes } from "./routes/members";
import { pageCreateRoutes, pageRecordRoutes } from "./routes/pages";
import { projectConfigRoutes } from "./routes/project-config";
import { projectRoutes } from "./routes/projects";
import { matchRoute, type Route } from "./routes/route";
import { createOpaqueToken, hashPassword, hashToken } from "./security";

const SESSION_COOKIE = "grimoire_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createGrimoireServer(options: Options) {
  const database = openDatabase(options.databasePath);
  // Verified against for an email no account answers to, so an unknown address costs
  // exactly one derivation - the same as a known one. Hashing the placeholder inside
  // the request would spend a second derivation, and that difference is measurable.
  const placeholderPasswordHash = hashPassword(createOpaqueToken());
  const pageStore = new MarkdownPageStore(
    options.pagesDirectory ?? join(dirname(options.databasePath), "pages"),
  );
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
  const loginAddressLimiter = new LoginRateLimiter({
    burst: LOGIN_ADDRESS_BURST,
    perMinute: LOGIN_ADDRESS_PER_MINUTE,
  });
  const loginAccountLimiter = new LoginRateLimiter({
    burst: LOGIN_ACCOUNT_BURST,
    perMinute: LOGIN_ACCOUNT_PER_MINUTE,
  });
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
   * The surface the route modules work through. Function declarations hoist, so the
   * closures it names are all live by the time the first request arrives.
   */
  const appContext: AppContext = {
    options,
    database,
    pageStore,
    ideaStore,
    chapterStore,
    avatarStore,
    imageStore,
    withAvatar,
    audit,
    auditAs,
    labelsForProject,
    requireChaptersEnabled,
    requireProjectMembership,
    requireProjectOwner,
    requireProject,
    requireAgentWrite,
    broadcast,
    broadcastPresence,
    disconnectUserEvents,
    openEventStream,
    recapFor,
    sendRecap,
    runGithubSync,
    writeLimiter,
    auth: {
      placeholderPasswordHash,
      addressLimiter: loginAddressLimiter,
      accountLimiter: loginAccountLimiter,
      trustProxy,
      pendingSignIns,
      oidcProviders,
      currentOidc,
      environmentOidc,
      setSession,
      clearSession,
      oidcRedirectUri,
      signInWithIdentity,
      requireOnAProject,
      findUsableInvite,
      signupProjectId,
    },
  };
  const routes: Route[] = [
    ...authRoutes(appContext),
    ...boardRoutes(appContext),
    ...fileRoutes(appContext),
    ...githubRoutes(appContext),
    ...projectRoutes(appContext),
    ...projectConfigRoutes(appContext),
    ...chapterRoutes(appContext),
    ...memberRoutes(appContext),
    ...eventRoutes(appContext),
    ...activityRoutes(appContext),
    ...agentReviewRoutes(appContext),
    ...importRoutes(appContext),
    ...pageCreateRoutes(appContext),
    ...ideaRoutes(appContext),
    // Discussion's longer /api/pages/:id/... patterns must register ahead of the bare
    // page record routes, exactly as the chain read them.
    ...discussionRoutes(appContext),
    ...pageRecordRoutes(appContext),
  ];

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
    onMoved: ({
      projectId,
      page,
      from,
      to,
    }: {
      projectId: string;
      page: { id: string; title: string };
      from: string;
      to: string;
    }) => {
      recordAuditEvent(database, {
        projectId,
        actor: { id: null, name: "GitHub" },
        entityType: "page",
        entityId: page.id,
        entityTitle: page.title,
        action: "moved",
        changes: [
          {
            field: "column",
            from: PAGE_STATUS_LABELS[from as PageStatus],
            to: PAGE_STATUS_LABELS[to as PageStatus],
          },
        ],
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
      (candidate) =>
        candidate.slug !== slug &&
        candidate.closedAt !== null &&
        candidate.closedAt < (chapter.closedAt ?? "9999"),
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
  async function sendRecap(
    projectId: string,
    slug: string,
  ): Promise<{ sent: number; failed: number } | "no_webhook" | "not_found"> {
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
        json(response, 409, {
          error: error.message,
          conflict: true,
          field: error.field,
          current: error.current,
        });
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

    // Routes live in the table as they are carved out of the chain below; the chain
    // answers for whatever has not moved yet. When the last block moves, the chain goes.
    const routed = matchRoute(routes, method, url.pathname);
    if (routed) {
      await routed.route.handler(context, routed.match);
      return;
    }

    // Sixty-eight routes used to live here as a flat chain; they live in the table now,
    // and a path the table does not know is a path the server does not have.
    json(response, 404, { error: "Not found" });
  }

  /**
   * Turns one request into a live event stream and registers it for broadcasts. Kept
   * beside the broadcast machinery it feeds rather than in a route module, and reached
   * through the context: presence is derived from these streams, so opening one is a
   * statement about who is on the board.
   */
  function openEventStream(context: RequestContext, clientId: string): void {
    const user = requireUser(context);
    const projectId = requireProject(context, user);
    const { response } = context;
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
        categories ??= new Map(
          categoriesForProject(database, projectId).map((value) => [value.slug, value.name]),
        );
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
            chapterName:
              page.chapter && chaptersEnabled(database, String(project.id))
                ? (chapterStore.get(slug, page.chapter)?.name ?? null)
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
    const forwardedProtocol = trustProxy
      ? String(request.headers["x-forwarded-proto"] ?? "")
          .split(",")[0]!
          .trim()
      : "";
    const protocol = forwardedProtocol || (options.production ? "https" : url.protocol.replace(":", ""));
    const forwardedHost = trustProxy
      ? String(request.headers["x-forwarded-host"] ?? "")
          .split(",")[0]!
          .trim()
      : "";
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
        throw new HttpError(
          409,
          "Another account at your provider is already signed in to this Grimoire account.",
        );
      }
      linkOidcIdentity(database, identity.issuer, identity.subject, user.id);
      return requireOnAProject(existing);
    }

    const invite = inviteCode ? findUsableInvite(inviteCode) : null;
    const projectId = invite
      ? String(invite.project_id)
      : config.autoRegister
        ? signupProjectId(config)
        : null;
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

    withTransaction(database, () => {
      database
        .prepare(
          "INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)",
        )
        .run(userId, name, identity.email, passwordHash, now);
      database
        .prepare(
          "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
        )
        .run(projectId, userId, now);
      if (invite) {
        const update = database
          .prepare("UPDATE invites SET used_by = ? WHERE id = ? AND used_by IS NULL")
          .run(userId, String(invite.id));
        if (Number(update.changes) !== 1) throw new HttpError(409, "Invitation has already been used");
      }
    });

    linkOidcIdentity(database, identity.issuer, identity.subject, userId);
    const user = withAvatar(publicUser(findUserById(database, userId)!));
    auditAs(user, {
      projectId,
      entityType: "member",
      entityId: userId,
      entityTitle: user.name,
      action: "joined",
    });
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
      auditAs(
        { ...user, email },
        {
          projectId,
          entityType: "member",
          entityId: user.id,
          entityTitle: user.name,
          action: "updated",
        },
      );
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
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
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
      if (client.projectId !== projectId || (excludedClientId && client.clientId === excludedClientId))
        continue;
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
