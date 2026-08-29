import { describe, expect, it } from "vitest";
import { fakeProvider, ISSUER } from "./oidc-provider";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

type Server = Awaited<ReturnType<typeof startTestServer>>;

/** Starts a sign-in and reads back the state the provider would be handed. */
async function beginSignIn(
  server: Server,
  query = "",
): Promise<{ state: string; nonce: string; cookie: string }> {
  const started = await server.fetchRaw(`/api/auth/oidc${query}`, { redirect: "manual" });
  expect(started.status).toBe(302);
  const destination = new URL(started.headers.get("location")!);
  const cookie = started.headers.getSetCookie().find((value) => value.startsWith("grimoire_oidc_state="))!;
  return {
    state: destination.searchParams.get("state")!,
    nonce: destination.searchParams.get("nonce")!,
    cookie: cookie.split(";")[0]!,
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
  return (
    new URL(response.headers.get("location")!, "http://localhost").searchParams.get("signin_error") ?? ""
  );
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
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const session = await server.request<{ oidc?: { label: string } }>("/api/session");
    expect(session.body.oidc).toEqual({ label: "Authentik" });
  });

  it("sends the browser to the provider with a challenge and a state it has to come back with", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
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
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    // The owner signs in through the provider rather than with their password.
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email, name: "Somebody Else" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/");

    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;
    const who = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: session.split(";")[0]! } });
    const body = (await who.json()) as {
      status: string;
      user: { email: string; name: string; role: string };
    };
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
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
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
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const { state, nonce, cookie } = await beginSignIn(
      server,
      `?invite=${encodeURIComponent(invite.body.code)}`,
    );
    provider.issue("code-1", provider.claimsFor(nonce, { email: "alan@team.example.test", name: "Alan" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.status).toBe(302);
    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;

    const who = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: session.split(";")[0]! } });
    const body = (await who.json()) as { user: { email: string; name: string; role: string } };
    expect(body.user).toMatchObject({ email: "alan@team.example.test", name: "Alan", role: "member" });

    // The invitation was single use before, and it still is.
    const second = await beginSignIn(server, `?invite=${encodeURIComponent(invite.body.code)}`);
    provider.issue(
      "code-2",
      provider.claimsFor(second.nonce, { email: "another@example.com", sub: "other" }),
    );
    const reused = await callback(
      server,
      `code=code-2&state=${encodeURIComponent(second.state)}`,
      second.cookie,
    );
    expect(refusal(reused)).toContain("invitation");
  });

  it("creates an account without an invitation when auto-registration is on", async () => {
    const provider = fakeProvider({ config: { autoRegister: true } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: "alan@team.example.test" }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    const session = landed.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="))!;
    const board = await fetch(`${server.baseUrl}/api/board`, { headers: { cookie: session.split(";")[0]! } });
    // The new account landed on a project, which is the difference between an account and
    // an account that can see anything.
    expect(board.status).toBe(200);
  });

  it("refuses an email the provider will not say it verified", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email, email_verified: false }));

    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(refusal(landed)).toContain("verified");
    expect(landed.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(false);
  });

  it("refuses a callback that did not start in this browser", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
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
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));

    const first = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(first.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(true);

    const replayed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(refusal(replayed)).toContain("expired");
  });

  it("accepts the scheme-less issuer Google documents, and nothing looser", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    // Google's own documentation says its id tokens carry either "https://accounts.google.com"
    // or the bare "accounts.google.com", so refusing the second would refuse Google.
    const bare = await beginSignIn(server);
    provider.issue(
      "code-1",
      provider.claimsFor(bare.nonce, { iss: "id.example.com", email: ownerAccount.email }),
    );
    const accepted = await callback(
      server,
      `code=code-1&state=${encodeURIComponent(bare.state)}`,
      bare.cookie,
    );
    expect(accepted.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(true);

    // The allowance is only the https prefix. A different host is still a different issuer.
    const impostor = await beginSignIn(server);
    provider.issue(
      "code-2",
      provider.claimsFor(impostor.nonce, { iss: "evil.example.com", email: ownerAccount.email }),
    );
    const refusedHost = await callback(
      server,
      `code=code-2&state=${encodeURIComponent(impostor.state)}`,
      impostor.cookie,
    );
    expect(refusal(refusedHost)).toContain("another issuer");

    // And http is never quietly taken for https.
    const insecure = await beginSignIn(server);
    provider.issue(
      "code-3",
      provider.claimsFor(insecure.nonce, { iss: "http://id.example.com", email: ownerAccount.email }),
    );
    const refusedScheme = await callback(
      server,
      `code=code-3&state=${encodeURIComponent(insecure.state)}`,
      insecure.cookie,
    );
    expect(refusal(refusedScheme)).toContain("another issuer");
  });

  it("refuses a token issued for another application, or answering another sign-in", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const wrongAudience = await beginSignIn(server);
    provider.issue(
      "code-1",
      provider.claimsFor(wrongAudience.nonce, { aud: "somebody-else", email: ownerAccount.email }),
    );
    const audienceRefused = await callback(
      server,
      `code=code-1&state=${encodeURIComponent(wrongAudience.state)}`,
      wrongAudience.cookie,
    );
    expect(refusal(audienceRefused)).toContain("another application");

    const wrongNonce = await beginSignIn(server);
    provider.issue(
      "code-2",
      provider.claimsFor("a nonce from somewhere else", { email: ownerAccount.email }),
    );
    const nonceRefused = await callback(
      server,
      `code=code-2&state=${encodeURIComponent(wrongNonce.state)}`,
      wrongNonce.cookie,
    );
    expect(refusal(nonceRefused)).toContain("different sign-in");
  });

  it("refuses a token that has expired, and one signed by a key the provider does not publish", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const expired = await beginSignIn(server);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    provider.issue(
      "code-1",
      provider.claimsFor(expired.nonce, { email: ownerAccount.email, exp: stale, iat: stale - 60 }),
    );
    const expiredRefused = await callback(
      server,
      `code=code-1&state=${encodeURIComponent(expired.state)}`,
      expired.cookie,
    );
    expect(refusal(expiredRefused)).toContain("expired");

    // Every claim is right and the signature is by a key the provider never published, which
    // is what a forged token, or one relayed from elsewhere, looks like from here.
    const forged = await beginSignIn(server);
    provider.issueForged("code-2", provider.claimsFor(forged.nonce, { email: ownerAccount.email }));
    const forgedRefused = await callback(
      server,
      `code=code-2&state=${encodeURIComponent(forged.state)}`,
      forged.cookie,
    );
    expect(refusal(forgedRefused)).toContain("signature");
    expect(forgedRefused.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(
      false,
    );
  });

  it("carries the person back to the page they signed in from", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(server, "?return=%2F%3Fproject%3Dabc");
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));
    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.headers.get("location")).toBe("/?project=abc");
  });

  it("will not be turned into a redirect to somewhere else", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const { state, nonce, cookie } = await beginSignIn(
      server,
      "?return=https%3A%2F%2Fevil.example.com%2Ftake",
    );
    provider.issue("code-1", provider.claimsFor(nonce, { email: ownerAccount.email }));
    const landed = await callback(server, `code=code-1&state=${encodeURIComponent(state)}`, cookie);
    expect(landed.headers.get("location")).toBe("/");
  });

  it("refuses an address on a domain the operator did not allow", async () => {
    const provider = fakeProvider({ config: { autoRegister: true, allowedEmailDomains: ["team.example.test"] } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const stranger = await beginSignIn(server);
    provider.issue("code-1", provider.claimsFor(stranger.nonce, { email: "someone@example.com" }));
    const refused = await callback(
      server,
      `code=code-1&state=${encodeURIComponent(stranger.state)}`,
      stranger.cookie,
    );
    expect(refusal(refused)).toContain("domain");

    // The same provider, an address that is on the list.
    const colleague = await beginSignIn(server);
    provider.issue(
      "code-2",
      provider.claimsFor(colleague.nonce, { email: "alan@team.example.test", sub: "other" }),
    );
    const admitted = await callback(
      server,
      `code=code-2&state=${encodeURIComponent(colleague.state)}`,
      colleague.cookie,
    );
    expect(admitted.headers.getSetCookie().some((value) => value.startsWith("grimoire_session="))).toBe(true);
  });

  it("is closed to agent credentials", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
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
