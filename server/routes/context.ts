import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { User } from "../../shared/types";
import type { AgentRateLimiter } from "../agent-tokens";
import type { Options, RequestContext, WorkspaceScope } from "../app-types";
import type { PageLabels, RecordAuditInput } from "../audit";
import type { AvatarStore } from "../avatars";
import { HttpError } from "../http";
import type { LoginRateLimiter } from "../login-rate-limit";
import type { MarkdownChapterStore } from "../markdown-chapters";
import type { MarkdownIdeaStore } from "../markdown-ideas";
import type { MarkdownPageStore } from "../markdown-pages";
import type { OidcConfig, OidcIdentity, PendingSignIns } from "../oidc";
import type { OidcProviders, OidcSource } from "../oidc-settings";
import type { ProjectImageStore } from "../project-images";

/**
 * What a route module gets to work with: the stores and database the server was
 * constructed around, and the closures that need server-wide state - the event
 * broadcast, the audit writers, the project guards. A route reaches everything through
 * this surface rather than through a shared closure, which is what lets sixty-eight of
 * them live in files a reader can hold.
 */
export type AppContext = {
  options: Options;
  database: DatabaseSync;
  pageStore: MarkdownPageStore;
  ideaStore: MarkdownIdeaStore;
  chapterStore: MarkdownChapterStore;
  avatarStore: AvatarStore;
  imageStore: ProjectImageStore;
  /** Decorates a user with their picture URL; the boards store people, not bytes. */
  withAvatar: <T extends User>(user: T) => T;
  audit: (context: RequestContext, input: Omit<RecordAuditInput, "actor">) => void;
  auditAs: (user: User, input: Omit<RecordAuditInput, "actor">, tokenId?: string | null) => void;
  labelsForProject: (projectId: string) => PageLabels;
  requireChaptersEnabled: (projectId: string) => void;
  requireProjectMembership: (user: User, projectId: string) => void;
  requireProjectOwner: (context: RequestContext, user: User, refusal: string) => string;
  requireProject: (context: RequestContext, user: User) => string;
  requireAgentWrite: (context: RequestContext) => void;
  broadcast: (projectId: string, scope: WorkspaceScope, excludedClientId: string | null) => void;
  broadcastPresence: (projectId: string) => void;
  disconnectUserEvents: (userId: string) => void;
  /** Turns the current request into a registered live event stream; see app.ts for why it lives there. */
  openEventStream: (context: RequestContext, clientId: string) => void;
  /** Reads a chapter's recap without posting it, so the owner can see what would go out. */
  recapFor: (projectId: string, chapterSlug: string) => unknown;
  /** Posts a chapter recap to the project's Discord webhook. */
  sendRecap: (
    projectId: string,
    chapterSlug: string,
  ) => Promise<"not_found" | "no_webhook" | { sent: number; failed: number }>;
  /** Brings every linked page up to date with GitHub, now rather than on the poll. */
  runGithubSync: (projectId: string) => Promise<void>;
  /** The per-credential write allowance, so revoking a token also forgets its bucket. */
  writeLimiter: AgentRateLimiter;
  /**
   * The sign-in machinery: sessions, the password limiters, and the provider flow. Grouped
   * because these travel together and nothing outside the auth routes should reach for them.
   */
  auth: {
    /** Derived once at construction; see the placeholder comment there for why. */
    placeholderPasswordHash: Promise<string>;
    addressLimiter: LoginRateLimiter;
    accountLimiter: LoginRateLimiter;
    trustProxy: boolean;
    pendingSignIns: PendingSignIns;
    oidcProviders: OidcProviders;
    /** The provider as it stands on this request - the settings screen edits it live. */
    currentOidc: () => { config: OidcConfig | null; source: OidcSource };
    environmentOidc: OidcConfig | null;
    setSession: (response: ServerResponse, userId: string) => void;
    clearSession: (response: ServerResponse) => void;
    oidcRedirectUri: (request: IncomingMessage, url: URL, config: OidcConfig | null) => string;
    signInWithIdentity: (
      identity: OidcIdentity,
      inviteCode: string | null,
      config: OidcConfig,
    ) => Promise<User>;
    requireOnAProject: (stored: Record<string, string | number | null>) => User;
    findUsableInvite: (code: string) => Record<string, string | null> | null;
    signupProjectId: (config: OidcConfig) => string | null;
  };
};

export function requireUser(context: RequestContext): User {
  if (!context.user) throw new HttpError(401, "Authentication required");
  return context.user;
}

/**
 * The one account that answers for the installation rather than for a project.
 *
 * Whoever set Grimoire up. How everybody signs in is theirs to decide, and deliberately not a
 * project owner's: an owner reshapes their own board, and a provider reaches every board.
 */
export function requireAdmin(context: RequestContext): User {
  const user = requireUser(context);
  if (user.role !== "admin")
    throw new HttpError(403, "Only the Grimoire admin can change how people sign in");
  return user;
}
