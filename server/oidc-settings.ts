import type { DatabaseSync } from "node:sqlite";
import type { OidcSettings, OidcSource } from "../shared/types";
import {
  emailDomainAllowed,
  OidcProvider,
  parseEmailDomains,
  parseIssuerInput,
  parseScopes,
  type OidcConfig,
  type OidcFetcher,
} from "./oidc";

/**
 * Where the provider's settings come from, and who is allowed to change them.
 *
 * Two places, in a fixed order. The environment wins, because a deployment that describes
 * itself in a file or a Compose stack should not drift the moment somebody opens a settings
 * screen, and an operator who has pinned their configuration wants it pinned. Everything
 * else is the screen: paste an address, press a button, sign in. That is the difference
 * between single sign-on being a feature this has and a feature people actually turn on.
 */
export type { OidcSettings, OidcSource };

export type OidcSettingsInput = {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  /** Absent leaves the stored secret alone; empty string forgets it. */
  clientSecret?: string;
  scopes?: string;
  label?: string;
  autoRegister?: boolean;
  allowedEmailDomains?: string;
  redirectUri?: string;
  signupProject?: string;
};

type SettingsRow = {
  enabled: number;
  issuer: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  label: string;
  auto_register: number;
  allowed_email_domains: string;
  redirect_uri: string;
  signup_project: string;
  updated_at: string | null;
};

const EMPTY: SettingsRow = {
  enabled: 0,
  issuer: "",
  client_id: "",
  client_secret: "",
  scopes: "",
  label: "",
  auto_register: 1,
  allowed_email_domains: "",
  redirect_uri: "",
  signup_project: "",
  updated_at: null,
};

function readRow(database: DatabaseSync): SettingsRow {
  const row = database.prepare("SELECT * FROM oidc_settings WHERE id = 1").get() as SettingsRow | undefined;
  return row ?? EMPTY;
}

export function saveOidcSettings(database: DatabaseSync, input: OidcSettingsInput, userId: string): void {
  const current = readRow(database);
  const next: SettingsRow = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
    issuer: input.issuer === undefined ? current.issuer : input.issuer.trim(),
    client_id: input.clientId === undefined ? current.client_id : input.clientId.trim(),
    client_secret: input.clientSecret === undefined ? current.client_secret : input.clientSecret.trim(),
    scopes: input.scopes === undefined ? current.scopes : input.scopes.trim(),
    label: input.label === undefined ? current.label : input.label.trim(),
    auto_register: input.autoRegister === undefined ? current.auto_register : input.autoRegister ? 1 : 0,
    allowed_email_domains:
      input.allowedEmailDomains === undefined ? current.allowed_email_domains : input.allowedEmailDomains.trim(),
    redirect_uri: input.redirectUri === undefined ? current.redirect_uri : input.redirectUri.trim(),
    signup_project: input.signupProject === undefined ? current.signup_project : input.signupProject.trim(),
    updated_at: new Date().toISOString(),
  };
  database
    .prepare(
      `INSERT INTO oidc_settings
         (id, enabled, issuer, client_id, client_secret, scopes, label, auto_register,
          allowed_email_domains, redirect_uri, signup_project, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled, issuer = excluded.issuer, client_id = excluded.client_id,
         client_secret = excluded.client_secret, scopes = excluded.scopes, label = excluded.label,
         auto_register = excluded.auto_register, allowed_email_domains = excluded.allowed_email_domains,
         redirect_uri = excluded.redirect_uri, signup_project = excluded.signup_project,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(
      next.enabled,
      next.issuer,
      next.client_id,
      next.client_secret,
      next.scopes,
      next.label,
      next.auto_register,
      next.allowed_email_domains,
      next.redirect_uri,
      next.signup_project,
      next.updated_at,
      userId,
    );
}

/** The stored settings as a usable configuration, or nothing when they are not usable yet. */
function storedConfig(database: DatabaseSync): OidcConfig | null {
  const row = readRow(database);
  if (!row.enabled || !row.issuer || !row.client_id) return null;
  const parsed = parseIssuerInput(row.issuer);
  if ("error" in parsed) return null;
  return {
    issuer: parsed.issuer,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    redirectUri: row.redirect_uri || null,
    scopes: parseScopes(row.scopes),
    label: row.label || parsed.hostname,
    autoRegister: row.auto_register === 1,
    allowedEmailDomains: parseEmailDomains(row.allowed_email_domains),
    signupProject: row.signup_project || null,
  };
}

/**
 * The provider in force right now, and where it came from.
 *
 * Resolved per request rather than at boot, because the whole point of the settings screen is
 * that turning single sign-on on does not mean restarting the server everybody else is using.
 */
export function resolveOidc(
  database: DatabaseSync,
  environmentConfig: OidcConfig | null,
): { config: OidcConfig | null; source: OidcSource } {
  if (environmentConfig) return { config: environmentConfig, source: "environment" };
  const stored = storedConfig(database);
  if (stored) return { config: stored, source: "settings" };
  return { config: null, source: readRow(database).issuer ? "settings" : "none" };
}

/**
 * What the settings screen shows, whichever place the configuration is coming from.
 *
 * An environment-configured installation still gets to see its own settings; the screen just
 * says they are read here and changed there, rather than pretending the fields are editable
 * and silently discarding what somebody types into them.
 */
export function oidcSettingsView(
  database: DatabaseSync,
  environmentConfig: OidcConfig | null,
  callbackUrl: string,
): OidcSettings {
  const row = readRow(database);
  if (environmentConfig) {
    return {
      source: "environment",
      enabled: true,
      issuer: environmentConfig.issuer,
      clientId: environmentConfig.clientId,
      clientSecretSet: environmentConfig.clientSecret !== "",
      scopes: environmentConfig.scopes.join(" "),
      label: environmentConfig.label,
      autoRegister: environmentConfig.autoRegister,
      allowedEmailDomains: environmentConfig.allowedEmailDomains.join(" "),
      redirectUri: environmentConfig.redirectUri ?? "",
      signupProject: environmentConfig.signupProject ?? "",
      callbackUrl: environmentConfig.redirectUri || callbackUrl,
      updatedAt: null,
    };
  }
  return {
    source: row.issuer || row.client_id ? "settings" : "none",
    enabled: row.enabled === 1,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecretSet: row.client_secret !== "",
    scopes: row.scopes,
    label: row.label,
    autoRegister: row.auto_register === 1,
    allowedEmailDomains: row.allowed_email_domains,
    redirectUri: row.redirect_uri,
    signupProject: row.signup_project,
    callbackUrl: row.redirect_uri || callbackUrl,
    updatedAt: row.updated_at,
  };
}

/**
 * Keeps one provider alive across requests for as long as its configuration is the same one.
 *
 * A provider caches the discovery document and the signing keys, and rebuilding it per request
 * would mean fetching both on every sign-in. Keying the cache on the configuration itself means
 * an edit in the settings screen takes effect on the next request without anything having to
 * remember to invalidate it.
 */
export class OidcProviders {
  private cached: { key: string; provider: OidcProvider } | null = null;

  constructor(private readonly fetcher: OidcFetcher) {}

  for(config: OidcConfig): OidcProvider {
    const key = JSON.stringify(config);
    if (this.cached?.key === key) return this.cached.provider;
    const provider = new OidcProvider(config, this.fetcher);
    this.cached = { key, provider };
    return provider;
  }

  /** A throwaway provider for a configuration nobody has saved yet, so it can be checked first. */
  probe(config: OidcConfig): OidcProvider {
    return new OidcProvider(config, this.fetcher);
  }
}

export { emailDomainAllowed };
