import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentToken, AgentTokenScope, User } from "../shared/types";
import { createOpaqueToken, hashToken } from "./security";

/**
 * Agent credentials: how something without a browser proves who it is acting as.
 *
 * A token is a delegation rather than an account. It belongs to one project and one person,
 * and every write it makes is attributed to that person, so revoking it is a complete answer
 * to "stop this agent" and the history it wrote still names someone accountable.
 */

/** Marks the secret in a log or a scanner as a Grimoire credential rather than noise. */
export const AGENT_TOKEN_PREFIX = "grim_";

/**
 * How many writes a token may make, and how fast it may refill.
 *
 * A looping agent is a file write, an audit row and a broadcast to every open browser per
 * page, so the ceiling exists to keep a runaway from being unbounded rather than to ration
 * ordinary use. A bulk run still finishes; it just stays interruptible while it does.
 */
export const AGENT_WRITE_BURST = 30;
export const AGENT_WRITE_PER_MINUTE = 60;

export type AgentIdentity = {
  tokenId: string;
  name: string;
  projectId: string;
  scope: AgentTokenScope;
  user: User;
};

type TokenRow = {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  owner_name: string;
  owner_email: string;
  owner_role: string;
};

export type IssuedAgentToken = {
  token: AgentToken;
  /** The only time the secret exists outside the holder's hands. */
  secret: string;
};

export function issueAgentToken(
  database: DatabaseSync,
  input: { projectId: string; userId: string; name: string; scope: AgentTokenScope; expiresAt?: string | null },
): IssuedAgentToken | null {
  const owner = database.prepare("SELECT name FROM users WHERE id = ?").get(input.userId) as
    | { name: string }
    | undefined;
  if (!owner) return null;

  const secret = `${AGENT_TOKEN_PREFIX}${createOpaqueToken()}`;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO agent_tokens (id, project_id, user_id, name, token_hash, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.projectId, input.userId, input.name, hashToken(secret), input.scope, createdAt, input.expiresAt ?? null);

  return {
    secret,
    token: {
      id,
      name: input.name,
      scope: input.scope,
      createdAt,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      ownerName: String(owner.name),
    },
  };
}

/** Every token ever issued for a project, newest first, including revoked ones. */
export function listAgentTokens(database: DatabaseSync, projectId: string): AgentToken[] {
  const rows = database
    .prepare(
      `SELECT agent_tokens.*, users.name AS owner_name
       FROM agent_tokens JOIN users ON users.id = agent_tokens.user_id
       WHERE agent_tokens.project_id = ?
       ORDER BY agent_tokens.created_at DESC`,
    )
    .all(projectId) as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    scope: String(row.scope) as AgentTokenScope,
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    ownerName: String(row.owner_name),
  }));
}

/**
 * Retires a token without deleting it.
 *
 * The row stays so `audit_events.agent_token_id` keeps resolving: a revoked agent's writes
 * should still say which agent made them, or revoking would quietly rewrite history.
 */
export function revokeAgentToken(database: DatabaseSync, projectId: string, tokenId: string): boolean {
  const result = database
    .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), tokenId, projectId);
  return Number(result.changes) > 0;
}

/**
 * Resolves a bearer secret to the identity it delegates, or null for anything unusable.
 *
 * Revoked and expired tokens resolve to null rather than to a lesser identity, so an
 * expired credential can never quietly degrade into read access.
 */
export function agentForToken(database: DatabaseSync, secret: string): AgentIdentity | null {
  if (!secret.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = database
    .prepare(
      `SELECT agent_tokens.*, users.name AS owner_name, users.email AS owner_email, users.role AS owner_role
       FROM agent_tokens JOIN users ON users.id = agent_tokens.user_id
       WHERE agent_tokens.token_hash = ?`,
    )
    .get(hashToken(secret)) as TokenRow | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return null;

  // The membership is checked on every request rather than trusted from issue time, so
  // removing someone from a project also stops the agents acting on their behalf. The
  // project has to still be live for the same reason: archiving refuses every browser,
  // and the owner-facing revoke routes go with it, so a credential that stayed alive
  // here would be one no human could ever stop again.
  const member = database
    .prepare(
      `SELECT 1 FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.project_id = ? AND project_members.user_id = ?
         AND projects.archived_at IS NULL`,
    )
    .get(row.project_id, row.user_id);
  if (!member) return null;

  return {
    tokenId: String(row.id),
    name: String(row.name),
    projectId: String(row.project_id),
    scope: String(row.scope) as AgentTokenScope,
    user: {
      id: String(row.user_id),
      name: String(row.owner_name),
      email: String(row.owner_email),
      // The account role, which is the admin or nothing at all. A token acts as whoever
      // issued it, and what it may reshape is settled per project by the routes themselves.
      role: row.owner_role === "admin" ? "admin" : "member",
    },
  };
}

/** Best-effort "when did this last do anything", for the settings list. */
export function touchAgentToken(database: DatabaseSync, tokenId: string): void {
  database.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), tokenId);
}

/**
 * A token bucket per credential, held in memory on purpose.
 *
 * Rate limiting protects the process that is running now; persisting it would mean a write
 * on every request to slow down writes. A restart forgiving the count is the right trade,
 * because the thing being prevented is a runaway loop, not a determined attacker.
 */
export class AgentRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly burst = AGENT_WRITE_BURST,
    private readonly perMinute = AGENT_WRITE_PER_MINUTE,
  ) {}

  /** Spends one write allowance, or reports that the caller has to wait. */
  take(tokenId: string, now = Date.now()): boolean {
    const refillPerMs = this.perMinute / 60000;
    const bucket = this.buckets.get(tokenId) ?? { tokens: this.burst, updatedAt: now };
    // The clock is wall time, and wall time steps backwards under NTP corrections and
    // snapshot restores. A negative elapsed term would drive the bucket deeply negative
    // and lock the credential out for the length of the step, so it is clamped instead.
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = Math.min(this.burst, bucket.tokens + elapsed * refillPerMs);
    if (refilled < 1) {
      this.buckets.set(tokenId, { tokens: refilled, updatedAt: now });
      return false;
    }
    this.buckets.set(tokenId, { tokens: refilled - 1, updatedAt: now });
    return true;
  }

  forget(tokenId: string): void {
    this.buckets.delete(tokenId);
  }
}
