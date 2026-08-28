import type { DatabaseSync } from "node:sqlite";

/**
 * The link between a provider's person and a Grimoire account.
 *
 * Email is how the link is *made*, and the subject id is how it is *kept*. Those are different
 * jobs and it matters that they are done by different values: an address is what somebody
 * already recognises about a colleague, which is what makes the first sign-in after turning
 * single sign-on on land on the account they already had - and it is also a thing people
 * change, which is exactly what a durable identity must not be.
 *
 * The subject id is opaque, stable, and means nothing outside the provider that issued it,
 * which is why it is stored beside that issuer rather than on its own.
 */
export type OidcLink = {
  issuer: string;
  subject: string;
  userId: string;
  linkedAt: string;
  lastSignInAt: string | null;
};

type LinkRow = {
  issuer: string;
  subject: string;
  user_id: string;
  linked_at: string;
  last_sign_in_at: string | null;
};

function toLink(row: LinkRow): OidcLink {
  return {
    issuer: row.issuer,
    subject: row.subject,
    userId: row.user_id,
    linkedAt: row.linked_at,
    lastSignInAt: row.last_sign_in_at,
  };
}

/** The account this provider identity is already known to be, if it is known at all. */
export function findOidcLink(database: DatabaseSync, issuer: string, subject: string): OidcLink | null {
  const row = database
    .prepare("SELECT * FROM oidc_identities WHERE issuer = ? AND subject = ?")
    .get(issuer, subject) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

/** Whether an account is already spoken for by this provider, under a different subject. */
export function oidcLinkForUser(database: DatabaseSync, issuer: string, userId: string): OidcLink | null {
  const row = database
    .prepare("SELECT * FROM oidc_identities WHERE issuer = ? AND user_id = ?")
    .get(issuer, userId) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

/**
 * Writes the link down, or moves it.
 *
 * A subject that already names an account is repointed rather than duplicated, so re-linking is
 * an update and never two rows disagreeing about who somebody is.
 */
export function linkOidcIdentity(
  database: DatabaseSync,
  issuer: string,
  subject: string,
  userId: string,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO oidc_identities (issuer, subject, user_id, linked_at, last_sign_in_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(issuer, subject) DO UPDATE SET user_id = excluded.user_id, last_sign_in_at = excluded.last_sign_in_at`,
    )
    .run(issuer, subject, userId, now, now);
}

/** Best-effort "this link was used", for the admin deciding whether a provider is still in use. */
export function touchOidcLink(database: DatabaseSync, issuer: string, subject: string): void {
  database
    .prepare("UPDATE oidc_identities SET last_sign_in_at = ? WHERE issuer = ? AND subject = ?")
    .run(new Date().toISOString(), issuer, subject);
}

/**
 * How many accounts have been linked to a provider at all.
 *
 * Deliberately not scoped to the issuer currently configured. The issuer a link is recorded
 * under is the canonical one the provider asserts, which is not always the string the operator
 * typed - somebody who pasted a discovery URL has a configuration that names the provider by a
 * different address than the tokens do. Counting by that string would read zero for a working
 * installation, which is worse than counting one stale link after a provider is swapped.
 */
export function countOidcLinks(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS total FROM oidc_identities").get() as
    { total: number } | undefined;
  return Number(row?.total ?? 0);
}
