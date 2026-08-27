import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { constants } from "node:crypto";
import { z } from "zod";

/**
 * Signing in with an identity provider the operator already runs.
 *
 * Single sign-on is the thing self-hosters ask for first and the thing they are most often
 * asked to pay for, so it is here, free, and it will stay free. It is deliberately additive:
 * password sign-in remains the default and is never disabled by configuring a provider, the
 * session it produces is the same opaque cookie every other sign-in produces, and nothing
 * downstream of `setSession` knows which door somebody came through.
 *
 * The whole flow is authorization code with PKCE against the provider's discovery document,
 * written on Node's own crypto rather than a client library. That is a deliberate cost: it
 * keeps Grimoire's dependency list short enough to audit and its image a single small
 * container, which is most of the argument for running it at all.
 */

export type OidcConfig = {
  /**
   * Whatever the operator pasted: an issuer, or a discovery URL.
   *
   * Both are accepted because both are what providers hand people. Some providers do not sit
   * at the standard well-known path at all, so demanding an issuer would lock them out.
   */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Set when the operator pins it; otherwise derived from the request that starts the flow. */
  redirectUri: string | null;
  scopes: string[];
  /** What the sign-in button calls the provider. */
  label: string;
  /**
   * Whether somebody the provider vouches for gets an account without an invitation.
   *
   * On by default, because a team that has just pointed Grimoire at their own identity
   * provider has already said who is allowed in, and making them each also click an
   * invitation link is asking the same question twice.
   */
  autoRegister: boolean;
  /**
   * The email domains that may sign in at all, when the operator names any.
   *
   * This is the guard that makes auto-registration safe to leave on. Pointed at a provider
   * that is only your team, it is unnecessary; pointed at a shared or public one - a Google
   * or an Entra tenant that is not only yours - it is the difference between "my team" and
   * "anybody with an account there".
   */
  allowedEmailDomains: string[];
  /** Which project a created account joins; the oldest one when unset. */
  signupProject: string | null;
};

/** Stands in for the provider in tests, the way `GithubFetcher` stands in for GitHub. */
export type OidcFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; body: unknown }>;

export const oidcHttpFetcher: OidcFetcher = async (url, init = {}) => {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    redirect: "error",
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A provider answering with something other than JSON is a misconfiguration, and the
    // status alone is a better error than a parse failure nobody can act on.
    body = null;
  }
  return { status: response.status, body };
};

/** A refusal whose message is written to be shown to the person who was signing in. */
export class OidcError extends Error {}

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url().optional(),
  userinfo_endpoint: z.string().url().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

/** Where a provider's configuration lives when it lives where the spec says it does. */
export const WELL_KNOWN_PATH = "/.well-known/openid-configuration";

type Discovery = z.infer<typeof discoverySchema>;

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
});

/** What every provider understands, and enough to know who somebody is. */
export const DEFAULT_SCOPES = ["openid", "email", "profile"];
/** Discovery is stable enough to cache and cheap enough to refetch hourly. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** A signing key rotation is answered by refetching when a key id is unknown, not by expiry alone. */
const JWKS_TTL_MS = 10 * 60 * 1000;
/** Clocks between two servers disagree; this is how much disagreement a token survives. */
const CLOCK_SKEW_SECONDS = 120;

/**
 * Reads the provider out of the environment, or reports that there is none.
 *
 * A half-written configuration throws rather than quietly disabling the button: an operator
 * who set two of the three variables has said what they want, and a silently missing sign-in
 * option is the hardest kind of misconfiguration to notice.
 */
export function oidcConfigFromEnvironment(environment: Record<string, string | undefined>): OidcConfig | null {
  const issuer = environment.GRIMOIRE_OIDC_ISSUER?.trim();
  const clientId = environment.GRIMOIRE_OIDC_CLIENT_ID?.trim();
  const clientSecret = environment.GRIMOIRE_OIDC_CLIENT_SECRET?.trim() ?? "";
  if (!issuer && !clientId) return null;
  if (!issuer || !clientId) {
    throw new Error("OIDC needs both GRIMOIRE_OIDC_ISSUER and GRIMOIRE_OIDC_CLIENT_ID, or neither");
  }

  const parsed = parseIssuerInput(issuer);
  if ("error" in parsed) throw new Error(`GRIMOIRE_OIDC_ISSUER ${parsed.error}`);

  const autoRegister = environment.GRIMOIRE_OIDC_AUTO_REGISTER?.trim();
  if (autoRegister !== undefined && autoRegister !== "" && !/^(1|0|true|false|yes|no)$/i.test(autoRegister)) {
    throw new Error(`GRIMOIRE_OIDC_AUTO_REGISTER must be true or false: ${autoRegister}`);
  }

  return {
    issuer: parsed.issuer,
    clientId,
    clientSecret,
    redirectUri: environment.GRIMOIRE_OIDC_REDIRECT_URI?.trim() || null,
    scopes: parseScopes(environment.GRIMOIRE_OIDC_SCOPES),
    label: environment.GRIMOIRE_OIDC_LABEL?.trim() || parsed.hostname,
    autoRegister: autoRegister ? /^(1|true|yes)$/i.test(autoRegister) : true,
    allowedEmailDomains: parseEmailDomains(environment.GRIMOIRE_OIDC_ALLOWED_EMAIL_DOMAINS),
    signupProject: environment.GRIMOIRE_OIDC_SIGNUP_PROJECT?.trim() || null,
  };
}

/**
 * Reads whatever the operator pasted into the issuer box.
 *
 * Providers hand people three different strings and call them all the same thing: an issuer,
 * an issuer with a trailing slash, and the full discovery URL. Refusing two of the three is
 * a support thread rather than a security property, so all three are accepted here and the
 * difference is remembered, because it decides one real check later - see `discover`.
 */
export function parseIssuerInput(value: string): { issuer: string; hostname: string; pastedDiscovery: boolean } | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: "is empty" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return { error: `is not a URL: ${trimmed}` };
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    return { error: "must be https, except against localhost" };
  }
  const pastedDiscovery = parsed.pathname.endsWith(WELL_KNOWN_PATH);
  const issuer = pastedDiscovery ? parsed.toString() : parsed.toString().replace(/\/+$/, "");
  return { issuer, hostname: parsed.hostname, pastedDiscovery };
}

export function parseScopes(value: string | undefined): string[] {
  const scopes = (value ?? "").split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
  return scopes.length > 0 ? [...new Set(["openid", ...scopes])] : DEFAULT_SCOPES;
}

export function parseEmailDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** Whether an address is one the operator said may sign in. An empty list means anybody may. */
export function emailDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return allowed.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

/** What the provider told us about the person, reduced to what an account needs. */
export type OidcIdentity = {
  /**
   * The issuer as the verified token names it, not as the operator typed it.
   *
   * A subject id means nothing except under the issuer that minted it, so the two are only
   * ever recorded together - and the one worth recording is the canonical one the provider
   * asserts, which is also the one the signature was checked against.
   */
  issuer: string;
  /** Opaque, stable, and the provider's own: what does not change when an address does. */
  subject: string;
  email: string;
  name: string | null;
};

export class OidcProvider {
  private discovery: { document: Discovery; fetchedAt: number } | null = null;
  private jwks: { keys: Array<Record<string, unknown>>; fetchedAt: number } | null = null;

  constructor(
    readonly config: OidcConfig,
    private readonly fetcher: OidcFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  /** The URL the provider's configuration is read from, whichever form was pasted. */
  get discoveryUrl(): string {
    const input = parseIssuerInput(this.config.issuer);
    if ("error" in input) return this.config.issuer;
    return input.pastedDiscovery ? input.issuer : `${input.issuer}${WELL_KNOWN_PATH}`;
  }

  async discover(): Promise<Discovery> {
    const cached = this.discovery;
    if (cached && this.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.document;

    const input = parseIssuerInput(this.config.issuer);
    if ("error" in input) throw new OidcError(`The sign-in provider's address ${input.error}`);

    const { status, body } = await this.fetcher(this.discoveryUrl);
    if (status === 404) {
      throw new OidcError(
        `No provider configuration at ${this.discoveryUrl} (404). If your provider publishes it elsewhere, paste that full URL instead of the issuer.`,
      );
    }
    if (status !== 200) throw new OidcError(`The sign-in provider could not be reached (${status})`);
    const parsed = discoverySchema.safeParse(body);
    if (!parsed.success) {
      throw new OidcError(`The address ${this.discoveryUrl} did not answer with a provider configuration`);
    }
    // The spec's anti-spoofing check: a document fetched from the well-known path under an
    // issuer must name that issuer. It only applies when the issuer is what built the URL -
    // an operator who pasted the discovery URL outright has already chosen the document, and
    // holding them to it would refuse every provider that does not sit at the standard path.
    if (!input.pastedDiscovery && parsed.data.issuer.replace(/\/+$/, "") !== input.issuer) {
      throw new OidcError(
        `The provider at ${input.issuer} calls itself ${parsed.data.issuer}. Use that as the issuer, or paste its discovery URL.`,
      );
    }
    this.discovery = { document: parsed.data, fetchedAt: this.now() };
    return parsed.data;
  }

  /**
   * What the provider says about itself, for the operator setting it up.
   *
   * This is what the setup screen fills its fields from and what its check reports. It proves
   * the provider is reachable and speaks the protocol; it cannot prove the client id and
   * secret, which only an actual sign-in exercises, and the screen says so rather than
   * implying a green tick means more than it does.
   */
  async describe(): Promise<{
    issuer: string;
    discoveryUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string | null;
    jwksUri: string | null;
    signingAlgorithms: string[];
    supportsPkce: boolean;
    scopesSupported: string[];
    signingKeyCount: number;
  }> {
    const document = await this.discover();
    let signingKeyCount = 0;
    if (document.jwks_uri) signingKeyCount = (await this.signingKeys(true)).length;
    return {
      issuer: document.issuer,
      discoveryUrl: this.discoveryUrl,
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      userinfoEndpoint: document.userinfo_endpoint ?? null,
      jwksUri: document.jwks_uri ?? null,
      signingAlgorithms: document.id_token_signing_alg_values_supported ?? [],
      supportsPkce: (document.code_challenge_methods_supported ?? []).includes("S256"),
      scopesSupported: document.scopes_supported ?? [],
      signingKeyCount,
    };
  }

  private async signingKeys(force: boolean): Promise<Array<Record<string, unknown>>> {
    const cached = this.jwks;
    if (!force && cached && this.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
    const { jwks_uri: jwksUri } = await this.discover();
    if (!jwksUri) throw new OidcError("The sign-in provider publishes no signing keys");
    const { status, body } = await this.fetcher(jwksUri);
    if (status !== 200) throw new OidcError(`The sign-in provider's signing keys could not be read (${status})`);
    const parsed = jwksSchema.safeParse(body);
    if (!parsed.success) throw new OidcError("The sign-in provider's signing keys are unusable");
    this.jwks = { keys: parsed.data.keys, fetchedAt: this.now() };
    return parsed.data.keys;
  }

  /** Where to send the browser to ask the provider who this is. */
  async authorizationUrl(input: { redirectUri: string; state: string; nonce: string; verifier: string }): Promise<string> {
    const { authorization_endpoint: endpoint } = await this.discover();
    const url = new URL(endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", challengeFor(input.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /**
   * Turns the code the browser came back with into who the provider says they are.
   *
   * The code is exchanged server to server, so the token never passes through the browser,
   * and the id token is verified against the provider's published keys even though it arrived
   * over TLS from the provider itself - the signature is what makes the claims evidence rather
   * than something a misrouted response could put in front of us.
   */
  async identify(input: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<OidcIdentity> {
    const discovery = await this.discover();
    const parameters = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      client_id: this.config.clientId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (this.config.clientSecret) {
      const methods = discovery.token_endpoint_auth_methods_supported;
      // Basic is the method every provider must support, so it is the assumption; a provider
      // that advertises only the post form is taken at its word.
      if (methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
        parameters.set("client_secret", this.config.clientSecret);
      } else {
        const pair = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
      }
    }

    const exchanged = await this.fetcher(discovery.token_endpoint, {
      method: "POST",
      headers,
      body: parameters.toString(),
    });
    if (exchanged.status !== 200) {
      throw new OidcError("The sign-in provider refused to complete the sign-in");
    }
    const tokens = tokenResponseSchema.safeParse(exchanged.body);
    if (!tokens.success) throw new OidcError("The sign-in provider returned no identity token");

    const claims = await this.verifyIdToken(tokens.data.id_token, input.nonce, discovery);
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (!subject) throw new OidcError("The sign-in provider returned an identity with no subject");

    let email = typeof claims.email === "string" ? claims.email : null;
    let emailVerified = claims.email_verified;
    let name = typeof claims.name === "string" ? claims.name : null;

    // Some providers keep email out of the id token and only hand it to the userinfo endpoint.
    if (!email && discovery.userinfo_endpoint && tokens.data.access_token) {
      const info = await this.fetcher(discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.data.access_token}`, accept: "application/json" },
      });
      if (info.status === 200 && info.body && typeof info.body === "object") {
        const record = info.body as Record<string, unknown>;
        if (typeof record.email === "string") email = record.email;
        if (typeof record.name === "string" && !name) name = record.name;
        if (record.email_verified !== undefined) emailVerified = record.email_verified;
      }
    }

    if (!email) throw new OidcError("The sign-in provider returned no email address");
    // An account is matched by email, so an email the provider itself will not vouch for is
    // an account takeover waiting for somebody to set their address to a colleague's. A
    // provider that says nothing about verification is trusted; one that says no is not.
    if (emailVerified === false) throw new OidcError("The sign-in provider has not verified that email address");

    return {
      issuer: discovery.issuer.replace(/\/+$/, ""),
      subject,
      email: email.trim().toLowerCase(),
      name: name?.trim() || null,
    };
  }

  private async verifyIdToken(token: string, nonce: string, discovery: Discovery): Promise<Record<string, unknown>> {
    const segments = token.split(".");
    if (segments.length !== 3) throw new OidcError("The identity token is malformed");
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const header = decodeSegment(headerSegment);
    const claims = decodeSegment(payloadSegment);
    const algorithm = typeof header.alg === "string" ? header.alg : "";
    const signature = Buffer.from(signatureSegment, "base64url");
    const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8");

    if (algorithm in HMAC_ALGORITHMS) {
      if (!this.config.clientSecret) throw new OidcError("The identity token is signed with a secret we do not hold");
      const expected = createHmac(HMAC_ALGORITHMS[algorithm], this.config.clientSecret).update(signed).digest();
      if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
        throw new OidcError("The identity token's signature is not valid");
      }
    } else {
      const keyId = typeof header.kid === "string" ? header.kid : null;
      // A rotation looks exactly like an unknown key id, so one miss earns one refetch.
      let key = findKey(await this.signingKeys(false), keyId, algorithm);
      if (!key) key = findKey(await this.signingKeys(true), keyId, algorithm);
      if (!key) throw new OidcError("The identity token was signed with an unknown key");
      if (!verifyAsymmetric(algorithm, signed, signature, key)) {
        throw new OidcError("The identity token's signature is not valid");
      }
    }

    if (typeof claims.iss !== "string" || !issuerMatches(claims.iss, discovery.issuer)) {
      throw new OidcError("The identity token came from another issuer");
    }

    const audience = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
    if (!audience.includes(this.config.clientId)) throw new OidcError("The identity token was issued for another application");
    // With more than one audience the token is shared, and only `azp` says it was meant for us.
    if (audience.length > 1 && claims.azp !== undefined && claims.azp !== this.config.clientId) {
      throw new OidcError("The identity token was issued for another application");
    }

    const seconds = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < seconds) {
      throw new OidcError("The identity token has expired");
    }
    if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > seconds) {
      throw new OidcError("The identity token is dated in the future");
    }
    // The nonce ties this token to the browser that started the flow, which is what stops a
    // token captured somewhere else from being replayed into somebody's session here.
    if (claims.nonce !== nonce) throw new OidcError("The identity token answers a different sign-in");

    return claims;
  }
}

/**
 * The sign-ins that have been started and not yet come back.
 *
 * Held in memory because a flow that outlives a restart is a flow nobody is still waiting on:
 * the browser is a redirect away from starting a new one, and persisting the verifier would
 * mean writing a secret to disk to save somebody a click.
 */
export class PendingSignIns {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxPending = 500,
    private readonly now: () => number = Date.now,
  ) {}

  open(input: Omit<PendingSignIn, "createdAt">): void {
    this.sweep();
    if (this.pending.size >= this.maxPending) {
      const oldest = [...this.pending].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }
    this.pending.set(input.state, { ...input, createdAt: this.now() });
  }

  /** Takes a pending sign-in, which may only ever be taken once. */
  claim(state: string): PendingSignIn | null {
    this.sweep();
    const found = this.pending.get(state);
    if (!found) return null;
    this.pending.delete(state);
    return found;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [state, value] of this.pending) {
      if (value.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

export type PendingSignIn = {
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The invitation the browser carried, when it carried one. */
  invite: string | null;
  /** Where in the app to land afterwards, always a path on this installation. */
  returnTo: string;
  createdAt: number;
};

/** The random values one sign-in needs, all unguessable and all used exactly once. */
export function newSignInSecrets(): { state: string; nonce: string; verifier: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Where to land after signing in.
 *
 * Only a path on this installation is ever honoured. A redirect target that came in on a query
 * string and was not checked is how a sign-in link becomes an open redirect somebody sends to a
 * colleague, so anything that could name another origin is answered with the board root.
 */
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value.slice(0, 500);
}

const HMAC_ALGORITHMS: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
const RSA_ALGORITHMS: Record<string, string> = { RS256: "sha256", RS384: "sha384", RS512: "sha512" };
const PSS_ALGORITHMS: Record<string, string> = { PS256: "sha256", PS384: "sha384", PS512: "sha512" };
const EC_ALGORITHMS: Record<string, string> = { ES256: "sha256", ES384: "sha384", ES512: "sha512" };

/**
 * Whether a token's `iss` names the provider its configuration does.
 *
 * Exact, with one documented exception. Google states that its identity tokens carry either
 * `https://accounts.google.com` or the bare `accounts.google.com`, so an equality check
 * refuses Google roughly half the time - and "sometimes" is the worst way for a sign-in to
 * fail, because it looks like an outage rather than a bug.
 *
 * The exception is deliberately as narrow as the problem: only the `https://` prefix may
 * differ, the host must be identical, and `http://` never matches. Nothing here weakens the
 * check that matters anyway, which is that the token carried a signature from the key set
 * that provider publishes.
 */
function issuerMatches(claimed: string, expected: string): boolean {
  const trim = (value: string) => value.trim().replace(/\/+$/, "");
  const claim = trim(claimed);
  const wanted = trim(expected);
  return claim === wanted || wanted === `https://${claim}`;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new OidcError("The identity token is malformed");
  }
}

function findKey(
  keys: Array<Record<string, unknown>>,
  keyId: string | null,
  algorithm: string,
): Record<string, unknown> | null {
  const usable = keys.filter((key) => key.use === undefined || key.use === "sig");
  if (keyId) return usable.find((key) => key.kid === keyId) ?? null;
  // Without a key id there must be no ambiguity about which key signed it, so a provider
  // publishing several is refused rather than guessed at.
  const candidates = usable.filter((key) => key.alg === undefined || key.alg === algorithm);
  return candidates.length === 1 ? candidates[0] : null;
}

function verifyAsymmetric(
  algorithm: string,
  signed: Buffer,
  signature: Buffer,
  jwk: Record<string, unknown>,
): boolean {
  let key;
  try {
    key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  } catch {
    throw new OidcError("The sign-in provider published a key we cannot read");
  }

  if (algorithm in RSA_ALGORITHMS) {
    return verifySignature(RSA_ALGORITHMS[algorithm], signed, key, signature);
  }
  if (algorithm in PSS_ALGORITHMS) {
    return verifySignature(
      PSS_ALGORITHMS[algorithm],
      signed,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      signature,
    );
  }
  if (algorithm in EC_ALGORITHMS) {
    // JWS carries the raw r||s pair; the DER encoding Node assumes by default would not parse.
    return verifySignature(EC_ALGORITHMS[algorithm], signed, { key, dsaEncoding: "ieee-p1363" }, signature);
  }
  if (algorithm === "EdDSA") return verifySignature(null, signed, key, signature);
  throw new OidcError(`The identity token uses an unsupported signature algorithm (${algorithm})`);
}
