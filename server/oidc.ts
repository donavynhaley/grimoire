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

/** How a person who has no account yet may get one through the provider. */
export type OidcSignupMode = "invite" | "open";

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Set when the operator pins it; otherwise derived from the request that starts the flow. */
  redirectUri: string | null;
  scopes: string[];
  /** What the sign-in button calls the provider. */
  label: string;
  signup: OidcSignupMode;
  /** Which project an `open` signup joins; the oldest one when unset. */
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
});

type Discovery = z.infer<typeof discoverySchema>;

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
});

const DEFAULT_SCOPES = ["openid", "email", "profile"];
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

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error(`GRIMOIRE_OIDC_ISSUER is not a URL: ${issuer}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("GRIMOIRE_OIDC_ISSUER must be https, except against localhost");
  }

  const signup = environment.GRIMOIRE_OIDC_SIGNUP?.trim() || "invite";
  if (signup !== "invite" && signup !== "open") {
    throw new Error(`GRIMOIRE_OIDC_SIGNUP must be "invite" or "open": ${signup}`);
  }

  const scopes = (environment.GRIMOIRE_OIDC_SCOPES ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    // Trailing slashes are how two spellings of the same provider stop matching each other.
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUri: environment.GRIMOIRE_OIDC_REDIRECT_URI?.trim() || null,
    scopes: scopes.length > 0 ? [...new Set(["openid", ...scopes])] : DEFAULT_SCOPES,
    label: environment.GRIMOIRE_OIDC_LABEL?.trim() || parsed.hostname,
    signup,
    signupProject: environment.GRIMOIRE_OIDC_SIGNUP_PROJECT?.trim() || null,
  };
}

/** What the provider told us about the person, reduced to what an account needs. */
export type OidcIdentity = {
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

  private async discover(): Promise<Discovery> {
    const cached = this.discovery;
    if (cached && this.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.document;

    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    const { status, body } = await this.fetcher(url);
    if (status !== 200) throw new OidcError(`The sign-in provider could not be reached (${status})`);
    const parsed = discoverySchema.safeParse(body);
    if (!parsed.success) throw new OidcError("The sign-in provider returned an unusable configuration");
    // A discovery document that names a different issuer is either a misconfiguration or
    // somebody else's provider answering for this one, and both are refusals.
    if (parsed.data.issuer.replace(/\/+$/, "") !== this.config.issuer) {
      throw new OidcError("The sign-in provider's configuration names a different issuer");
    }
    this.discovery = { document: parsed.data, fetchedAt: this.now() };
    return parsed.data;
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

    return { subject, email: email.trim().toLowerCase(), name: name?.trim() || null };
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

    const issuer = typeof claims.iss === "string" ? claims.iss.replace(/\/+$/, "") : "";
    if (issuer !== discovery.issuer.replace(/\/+$/, "")) throw new OidcError("The identity token came from another issuer");

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
