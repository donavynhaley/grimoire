import { generateKeyPairSync, sign as signWith, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OidcConfig, OidcFetcher } from "../../server/oidc";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

const ISSUER = "https://id.example.com";

const config: OidcConfig = {
  issuer: ISSUER,
  clientId: "grimoire",
  clientSecret: "a shared secret",
  redirectUri: null,
  scopes: ["openid", "email", "profile"],
  label: "Authentik",
  signup: "invite",
  signupProject: null,
};

/**
 * A provider that signs real tokens with a real key.
 *
 * The point of standing one of these up rather than stubbing the verification is that every
 * refusal below is the actual signature and claim checking answering, so a change that quietly
 * stopped verifying would fail here rather than pass.
 */
function fakeProvider(options: { config?: Partial<OidcConfig> } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // A second key that is never published, so a token signed with it is what a forgery or a
  // relayed token from somewhere else looks like on the wire.
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-key", alg: "RS256" };
  const settings = { ...config, ...options.config };

  const claimsForCode = new Map<string, { claims: Record<string, unknown>; forged: boolean }>();
  let lastTokenRequest: { headers: Record<string, string>; body: string } | null = null;

  const idToken = (claims: Record<string, unknown>, forged: boolean) => {
    const header = { alg: "RS256", kid: "test-key", typ: "JWT" };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `${encode(header)}.${encode(claims)}`;
    const key: KeyObject = forged ? rogue.privateKey : privateKey;
    const signature = signWith("sha256", Buffer.from(signed), key).toString("base64url");
    return `${signed}.${signature}`;
  };

  const fetcher: OidcFetcher = async (url, init = {}) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        status: 200,
        body: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
      };
    }
    if (url === `${ISSUER}/jwks`) return { status: 200, body: { keys: [jwk] } };
    if (url === `${ISSUER}/token`) {
      lastTokenRequest = { headers: init.headers ?? {}, body: init.body ?? "" };
      const parameters = new URLSearchParams(init.body ?? "");
      const registered = claimsForCode.get(parameters.get("code") ?? "");
      if (!registered) return { status: 400, body: { error: "invalid_grant" } };
      return {
        status: 200,
        body: { id_token: idToken(registered.claims, registered.forged), access_token: "provider-access-token" },
      };
    }
    return { status: 404, body: null };
  };

  return {
    fetcher,
    settings,
    tokenRequest: () => lastTokenRequest,
    /** Registers what the provider will say about whoever redeems this code. */
    issue(code: string, claims: Record<string, unknown>) {
      claimsForCode.set(code, { claims, forged: false });
    },
    /** The same, signed with a key this provider never published. */
    issueForged(code: string, claims: Record<string, unknown>) {
      claimsForCode.set(code, { claims, forged: true });
    },
    claimsFor(nonce: string, overrides: Record<string, unknown> = {}) {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: ISSUER,
        aud: settings.clientId,
        sub: "provider-subject-1",
        exp: now + 300,
        iat: now,
        nonce,
        email: "alan@team.example.test",
        email_verified: true,
        name: "Alan",
        ...overrides,
      };
    },
  };
}

type Server = Awaited<ReturnType<typeof startTestServer>>;

/** Starts a sign-in and reads back the state the provider would be handed. */
async function beginSignIn(server: Server, query = ""): Promise<{ state: string; nonce: string; cookie: string }> {
  const started = await server.fetchRaw(`/api/auth/oidc${query}`, { redirect: "manual" });
  expect(started.status).toBe(302);
  const destination = new URL(started.headers.get("location")!);
  const cookie = started.headers.getSetCookie().find((value) => value.startsWith("grimoire_oidc_state="))!;
  return {
    state: destination.searchParams.get("state")!,
    nonce: destination.searchParams.get("nonce")!,
    cookie: cookie.split(";")[0],
  };
}

/**
 * The browser coming back from the provider, carrying only what the provider flow gave it.
 *
 * Deliberately not the shared request helper: that one attaches whatever session is signed in,
 * and every question here is about what the callback proves on its own.
 */
function callback(server: Server, query: string, cookie: string) {
  return fetch(`${server.baseUrl}/api/auth/oidc/callback?${query}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

/** The reason a refused sign-in carries back to the interface. */
function refusal(response: Response): string {
  return new URL(response.headers.get("location")!, "http://localhost").searchParams.get("signin_error") ?? "";
}

describe("signing in through an identity provider", () => {
  it("offers nothing when no provider is configured", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const session = await server.request<{ oidc?: unknown }>("/api/session");
    expect(session.body.oidc).toBeUndefined();

    const started = await server.fetchRaw("/api/auth/oidc", { redirect: "manual" });
    expect(started.status).toBe(404);
  });

  it("names the provider on the session so the sign-in screen can offer it", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const session = await server.request<{ oidc?: { label: string } }>("/api/session");
    expect(session.body.oidc).toEqual({ label: "Authentik" });
  });

  it("sends the browser to the provider with a challenge and a state it has to come back with", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const started = await server.fetchRaw("/api/auth/oidc", { redirect: "manual" });
    expect(started.status).toBe(302);

    const destination = new URL(started.headers.get("location")!);
    expect(destination.origin + destination.pathname).toBe(`${ISSUER}/authorize`);
    expect(destination.searchParams.get("response_type")).toBe("code");
    expect(destination.searchParams.get("client_id")).toBe("grimoire");
    expect(destination.searchParams.get("scope")).toBe("openid email profile");
    expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
    expect(destination.searchParams.get("code_challenge")).toBeTruthy();
    expect(destination.searchParams.get("redirect_uri")).toContain("/api/auth/oidc/callback");

    const cookie = started.headers.getSetCookie().find((value) => value.startsWith("grimoire_oidc_state="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(destination.searchParams.get("state")!);
  });

  it("signs in the account that already uses that email, keeping who they are", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    // The owner signs in through the provider rather than with their password.
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email, name: "Somebody Else" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/");

    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;
    const who = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: session.split(";")[0] } });
    const body = (await who.json()) as { status: string; user: { email: string; name: string; role: string } };
    expect(body.status).toBe("authenticated");
    expect(body.user.email).toBe(ownerAccount.email);
    // The provider does not get to rename an account that already exists, or promote it.
    expect(body.user.name).toBe("Donavyn");
    expect(body.user.role).toBe("admin");

    // The code was exchanged server to server, with the verifier and the client secret.
    const exchanged = new URLSearchParams(provider.tokenRequest()!.body);
    expect(exchanged.get("grant_type")).toBe("authorization_code");
    expect(exchanged.get("code_verifier")).toBeTruthy();
    expect(provider.tokenRequest()!.headers.authorization).toMatch(/^Basic /);
  });

  it("refuses an email no account uses, rather than letting the provider create one", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: "stranger@example.com" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.status).toBe(302);
    expect(refusal(landed)).toContain("invitation");
    expect(landed.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(false);
  });

  it("creates an account when the browser carried an invitation", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);
    const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({}) });

    const { state, nonce, cookie } = await beginSignIn(server, `?invite=${encodeURIComponent(invite.body.code)}`);
    provider.issue("code-1", provider.claimsFor(nonce, { email: "alan@team.example.test", name: "Alan" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.status).toBe(302);
    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;

    const who = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: session.split(";")[0] } });
    const body = (await who.json()) as { user: { email: string; name: string; role: string } };
    expect(body.user).toMatchObject({ email: "alan@team.example.test", name: "Alan", role: "member" });

    // The invitation was single use before, and it still is.
    const second = await beginSignIn(server, `?invite=${encodeURIComponent(invite.body.code)}`);
    provider.issue("code-2", provider.claimsFor(second.nonce, { email: "another@example.com", sub: "other" }));
    const reused = await callback(server, `code=code-2&state=${encodeURIComponent(second.state)}`, second.cookie);
    expect(refusal(reused)).toContain("invitation");
  });

  it("creates an account without an invitation only when the operator opened signup", async () => {
    const provider = fakeProvider({ config: { signup: "open" } });
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: "alan@team.example.test" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;
    const board = await fetch(`${server.baseUrl}/api/board`, { headers: { cookie: session.split(";")[0] } });
    // The new account landed on a project, which is the difference between an account and
    // an account that can see anything.
    expect(board.status).toBe(200);
  });

  it("refuses an email the provider will not say it verified", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email, email_verified: false }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(refusal(landed)).toContain("verified");
    expect(landed.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(false);
  });

  it("refuses a callback that did not start in this browser", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));

    // The state is right and the cookie is missing, which is what somebody else's callback
    // pasted into your browser looks like.
    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, "");
    expect(refusal(landed)).toContain("expired");
    expect(landed.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(false);
  });

  it("lets a sign-in be completed once", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));

    const first = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(first.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(true);

    const replayed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(refusal(replayed)).toContain("expired");
  });

  it("refuses a token issued for another application, or answering another sign-in", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const wrongAudience = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(wrongAudience.nonce, { aud: "somebody-else", email: ownerAccount.email }));
    const audienceRefused = await callback(server, `code=code-1&state=${encodeURIComponent(wrongAudience.state)}`, wrongAudience.cookie);
    expect(refusal(audienceRefused)).toContain("another application");

    const wrongNonce = await beginSignIn(server);
    provider.issue("code-2", provider.claimsFor("a nonce from somewhere else", { email: ownerAccount.email }));
    const nonceRefused = await callback(server, `code=code-2&state=${encodeURIComponent(wrongNonce.state)}`, wrongNonce.cookie);
    expect(refusal(nonceRefused)).toContain("different sign-in");
  });

  it("refuses a token that has expired, and one signed by a key the provider does not publish", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const expired = await beginSignIn(server);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    provider.issue("code-1", provider.claimsFor(expired.nonce, { email: ownerAccount.email, exp: stale, iat: stale - 60 }));
    const expiredRefused = await callback(server, `code=code-1&state=${encodeURIComponent(expired.state)}`, expired.cookie);
    expect(refusal(expiredRefused)).toContain("expired");

    // Every claim is right and the signature is by a key the provider never published, which
    // is what a forged token, or one relayed from elsewhere, looks like from here.
    const forged = await beginSignIn(server);
    provider.issueForged("code-2", provider.claimsFor(forged.nonce, { email: ownerAccount.email }));
    const forgedRefused = await callback(server, `code=code-2&state=${encodeURIComponent(forged.state)}`, forged.cookie);
    expect(refusal(forgedRefused)).toContain("signature");
    expect(forgedRefused.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(false);
  });

  it("carries the person back to the page they signed in from", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server, "?return=%2F%3Fproject%3Dabc");
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));
    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.headers.get("location")).toBe("/?project=abc");
  });

  it("will not be turned into a redirect to somewhere else", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server, "?return=https%3A%2F%2Fevil.example.com%2Ftake");
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));
    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.headers.get("location")).toBe("/");
  });

  it("is closed to agent credentials", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);
    const issued = await server.request<{ secret: string }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Planning agent", scope: "write" }),
    });

    const attempted = await fetch(`${server.baseUrl}/api/auth/oidc`, {
      redirect: "manual",
      headers: { authorization: `Bearer ${issued.body.secret}` },
    });
    expect(attempted.status).toBe(403);
  });
});
