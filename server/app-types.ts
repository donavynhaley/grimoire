import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../shared/types";
import type { AgentIdentity } from "./agent-tokens";
import type { GithubFetcher } from "./github";
import type { OidcConfig, OidcFetcher } from "./oidc";
import type { DiscordPoster } from "./recap";

/** What a Grimoire server is constructed from, and the seams tests stand things in through. */
export type Options = {
  pagesDirectory?: string;
  databasePath: string;
  production: boolean;
  staticDirectory?: string;
  /** Optional public Cloudflare site token, used only on the demo document. */
  demoAnalyticsToken?: string;
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

export type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  user: User | null;
  sessionToken: string | null;
  /** Set when a bearer token answered instead of a browser session. */
  agent: AgentIdentity | null;
};

export type WorkspaceScope = "work" | "ideas" | "both";

export type EventClient = {
  clientId: string;
  projectId: string;
  response: ServerResponse;
  keepAlive: ReturnType<typeof setInterval>;
  userId: string;
};
