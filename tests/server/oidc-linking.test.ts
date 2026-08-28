import { describe, expect, it } from "vitest";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";
import { fakeProvider, ISSUER } from "./oidc-provider";

type Server = Awaited<ReturnType<typeof startTestServer>>;

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

function callback(server: Server, query: string, cookie: string) {
  return fetch(`${server.baseUrl}/api/auth/oidc/callback?${query}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

function sessionCookie(response: Response): string | null {
  const found = response.headers.getSetCookie().find((value) => value.startsWith("grimoire_session="));
  return found ? found.split(";")[0]! : null;
}

function refusal(response: Response): string {
  return (
    new URL(response.headers.get("location")!, "http://localhost").searchParams.get("signin_error") ?? ""
  );
}

/** Signs in through the provider once, as whoever the claims say. */
async function signInThrough(
  server: Server,
  provider: ReturnType<typeof fakeProvider>,
  code: string,
  claims: Record<string, unknown>,
) {
  const { state, nonce, cookie } = await beginSignIn(server);
  provider.issue(code, provider.claimsFor(nonce, claims));
  return callback(server, `code=${code}&state=${encodeURIComponent(state)}`, cookie);
}

async function whoIs(server: Server, cookie: string) {
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie } });
  return (await response.json()) as { user: { id: string; email: string; name: string; role: string } };
}

describe("linking a provider identity to an account somebody already had", () => {
  it("signs a password account in and keeps everything about it", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    const created = await bootstrap(server);
    void created;
    const before = await whoIs(server, server.cookie());

    // The account existed with a password before single sign-on was ever configured.
    const landed = await signInThrough(server, provider, "code-1", {
      email: ownerAccount.email,
      name: "Somebody Else",
    });
    const session = sessionCookie(landed)!;
    const after = await whoIs(server, session);

    // The same account, not a second one wearing the same address.
    expect(after.user.id).toBe(before.user.id);
    expect(after.user.name).toBe("Donavyn");
    expect(after.user.role).toBe("admin");
  });

  it("matches an address however it was capitalised at either end", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);
    const before = await whoIs(server, server.cookie());

    const landed = await signInThrough(server, provider, "code-1", {
      email: ownerAccount.email.toUpperCase(),
    });
    const after = await whoIs(server, sessionCookie(landed)!);
    expect(after.user.id).toBe(before.user.id);
  });

  it("leaves the password working, so both doors reach the one account", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);
    const before = await whoIs(server, server.cookie());

    await signInThrough(server, provider, "code-1", { email: ownerAccount.email });
    await server.request("/api/auth/logout", { method: "POST" });

    const password = await server.request<{ user: { id: string } }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(password.response.status).toBe(200);
    expect(password.body.user.id).toBe(before.user.id);
  });

  it("follows somebody whose address changed at the provider, instead of stranding them", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);
    const before = await whoIs(server, server.cookie());

    // First sign-in: matched by email, and the link written down.
    await signInThrough(server, provider, "code-1", { email: ownerAccount.email, sub: "provider-subject-1" });

    // They change their address at the provider. Same person, same subject id, new email.
    const returned = await signInThrough(server, provider, "code-2", {
      email: "donavyn@team.example.test",
      sub: "provider-subject-1",
    });
    const after = await whoIs(server, sessionCookie(returned)!);

    // The account they already had, not a new empty one, and it now knows their address.
    expect(after.user.id).toBe(before.user.id);
    expect(after.user.email).toBe("donavyn@team.example.test");
    expect(after.user.role).toBe("admin");
  });

  it("will not walk an account onto an address another account already uses", async () => {
    const provider = fakeProvider({ config: { autoRegister: true } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    // A second account, made through the provider.
    await signInThrough(server, provider, "code-1", { email: "alan@team.example.test", sub: "provider-subject-2" });

    // That person's address at the provider becomes one the owner already answers to. Merging
    // two accounts is a person's decision about whose history survives, not a side effect.
    const collided = await signInThrough(server, provider, "code-2", {
      email: ownerAccount.email,
      sub: "provider-subject-2",
    });
    expect(refusal(collided)).toContain("another Grimoire account already uses");
    expect(sessionCookie(collided)).toBeNull();

    // And neither account was touched on the way past.
    const password = await server.request<{ user: { email: string } }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(password.response.status).toBe(200);
  });

  it("refuses a second provider person claiming an account the first one holds", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    await signInThrough(server, provider, "code-1", { email: ownerAccount.email, sub: "provider-subject-1" });

    // A different person at the provider, presenting the same address. Whichever way this were
    // guessed, somebody would end up signed in as somebody else.
    const impostor = await signInThrough(server, provider, "code-2", {
      email: ownerAccount.email,
      sub: "provider-subject-9",
    });
    expect(refusal(impostor)).toContain("already signed in to this Grimoire account");
    expect(sessionCookie(impostor)).toBeNull();
  });

  it("remembers a created account too, not only a matched one", async () => {
    const provider = fakeProvider({ config: { autoRegister: true } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const first = await signInThrough(server, provider, "code-1", {
      email: "alan@team.example.test",
      sub: "made-here",
    });
    const made = await whoIs(server, sessionCookie(first)!);

    const renamed = await signInThrough(server, provider, "code-2", {
      email: "alan@example.org",
      sub: "made-here",
    });
    const after = await whoIs(server, sessionCookie(renamed)!);
    expect(after.user.id).toBe(made.user.id);
    expect(after.user.email).toBe("alan@example.org");
  });

  it("stops signing somebody in once they are off every project, link or no link", async () => {
    const provider = fakeProvider({ config: { autoRegister: true } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const first = await signInThrough(server, provider, "code-1", {
      email: "alan@team.example.test",
      sub: "made-here",
    });
    const made = await whoIs(server, sessionCookie(first)!);

    const removed = await server.request(`/api/members/${made.user.id}`, { method: "DELETE" });
    expect(removed.response.status).toBe(200);

    // A recorded link is a claim about which account somebody is, never a reason to let them
    // in: the account is still there and still theirs, and it now reaches nothing. Password
    // sign-in refuses this exactly the same way.
    const again = await signInThrough(server, provider, "code-2", {
      email: "alan@team.example.test",
      sub: "made-here",
    });
    expect(refusal(again)).toContain("not on any project");
    expect(sessionCookie(again)).toBeNull();
  });

  it("tells the admin how many accounts sign in this way", async () => {
    const provider = fakeProvider({ config: { autoRegister: true } });
    const server = await startTestServer(undefined, {
      oidc: provider.settings,
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);

    const before = await server.request<{ settings: { linkedAccounts: number } }>("/api/auth/oidc/settings");
    expect(before.body.settings.linkedAccounts).toBe(0);

    await signInThrough(server, provider, "code-1", { email: ownerAccount.email, sub: "provider-subject-1" });
    await signInThrough(server, provider, "code-2", { email: "alan@team.example.test", sub: "provider-subject-2" });

    const after = await server.request<{ settings: { linkedAccounts: number } }>("/api/auth/oidc/settings");
    expect(after.body.settings.linkedAccounts).toBe(2);
  });

  it("records the issuer the token asserts, not the address somebody typed", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, {
      // Configured by its discovery URL, which is a different string from the issuer itself.
      oidc: { ...provider.settings, issuer: `${ISSUER}/.well-known/openid-configuration` },
      oidcFetcher: provider.fetcher,
    });
    await bootstrap(server);
    const before = await whoIs(server, server.cookie());

    await signInThrough(server, provider, "code-1", { email: ownerAccount.email, sub: "provider-subject-1" });
    // The link was written under the canonical issuer, so it is found again on the next
    // sign-in even though the configuration spells the provider differently.
    const returned = await signInThrough(server, provider, "code-2", {
      email: "moved@team.example.test",
      sub: "provider-subject-1",
    });
    const after = await whoIs(server, sessionCookie(returned)!);
    expect(after.user.id).toBe(before.user.id);
    expect(after.user.email).toBe("moved@team.example.test");
  });
});
