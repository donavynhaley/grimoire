import { describe, expect, it } from "vitest";
import type { OidcSettings, OidcProviderDescription } from "../../shared/types";
import { emailAllowed, oidcConfigFromEnvironment } from "../../server/oidc";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";
import { fakeProvider, ISSUER } from "./oidc-provider";

type Server = Awaited<ReturnType<typeof startTestServer>>;

function readSettings(server: Server) {
  return server.request<{ settings: OidcSettings }>("/api/auth/oidc/settings");
}

function writeSettings(server: Server, input: Record<string, unknown>) {
  return server.request<{ settings: OidcSettings; error?: string }>("/api/auth/oidc/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

describe("setting up a provider from the settings screen", () => {
  it("starts with nothing, and already knows the address to register", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const { body } = await readSettings(server);
    expect(body.settings.source).toBe("none");
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.clientSecretSet).toBe(false);
    // The value people most often get wrong is the one they never have to type.
    expect(body.settings.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oidc\/callback$/);
    // Auto-registration is the shipped default: a team that has pointed Grimoire at their own
    // provider has already said who is allowed in.
    expect(body.settings.autoRegister).toBe(true);
  });

  it("reads a provider's own configuration instead of asking somebody to transcribe it", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const probed = await server.request<{ provider: OidcProviderDescription }>("/api/auth/oidc/probe", {
      method: "POST",
      body: JSON.stringify({ issuer: ISSUER }),
    });
    expect(probed.response.status).toBe(200);
    expect(probed.body.provider).toMatchObject({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
    });
    expect(probed.body.provider.signingKeyCount).toBe(1);
  });

  it("accepts a trailing slash and a pasted discovery URL as the same provider", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    for (const address of [`${ISSUER}/`, `${ISSUER}/.well-known/openid-configuration`]) {
      const probed = await server.request<{ provider?: OidcProviderDescription; error?: string }>("/api/auth/oidc/probe", {
        method: "POST",
        body: JSON.stringify({ issuer: address }),
      });
      expect(probed.body.error, `${address} was refused`).toBeUndefined();
      expect(probed.body.provider?.issuer).toBe(ISSUER);
    }
  });

  it("says what went wrong rather than failing, when the address is not a provider", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const probed = await server.request<{ error?: string }>("/api/auth/oidc/probe", {
      method: "POST",
      body: JSON.stringify({ issuer: "https://not-a-provider.example.com" }),
    });
    expect(probed.response.status).toBe(200);
    expect(probed.body.error).toContain("openid-configuration");

    const refused = await server.request<{ error?: string }>("/api/auth/oidc/probe", {
      method: "POST",
      body: JSON.stringify({ issuer: "http://id.example.com" }),
    });
    expect(refused.response.status).toBe(400);
    expect(refused.body.error).toContain("https");
  });

  it("configures a working sign-in without touching the environment or restarting", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    // Nothing offered yet.
    const before = await server.request<{ oidc?: unknown }>("/api/session");
    expect(before.body.oidc).toBeUndefined();

    const saved = await writeSettings(server, {
      issuer: ISSUER,
      clientId: "grimoire",
      clientSecret: "a shared secret",
      label: "Authentik",
      enabled: true,
    });
    expect(saved.response.status).toBe(200);
    expect(saved.body.settings.source).toBe("settings");
    expect(saved.body.settings.clientSecretSet).toBe(true);
    // The secret is written once and never read back, not even by the admin who set it.
    expect(JSON.stringify(saved.body)).not.toContain("a shared secret");

    // The same process, no restart: the provider is now on offer.
    const after = await server.request<{ oidc?: { label: string } }>("/api/session");
    expect(after.body.oidc).toEqual({ label: "Authentik" });

    const started = await server.fetchRaw("/api/auth/oidc", { redirect: "manual" });
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toContain(`${ISSUER}/authorize`);
  });

  it("keeps the saved secret when something else on the screen is edited", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    await writeSettings(server, { issuer: ISSUER, clientId: "grimoire", clientSecret: "a shared secret" });
    // The screen saves a field at a time, so every other save arrives without a secret in it.
    const renamed = await writeSettings(server, { label: "Keycloak" });
    expect(renamed.body.settings.clientSecretSet).toBe(true);
    expect(renamed.body.settings.label).toBe("Keycloak");

    const forgotten = await writeSettings(server, { clientSecret: "" });
    expect(forgotten.body.settings.clientSecretSet).toBe(false);
  });

  it("will not be enabled into a half-configured state that offers a broken button", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    await writeSettings(server, { enabled: true, issuer: ISSUER });
    // Enabled, but with no client id there is nothing to sign in as, so nothing is offered.
    const session = await server.request<{ oidc?: unknown }>("/api/session");
    expect(session.body.oidc).toBeUndefined();
  });

  it("refuses an address that is not a URL, before it is stored", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const refused = await writeSettings(server, { issuer: "not a url at all" });
    expect(refused.response.status).toBe(400);
  });

  it("is the admin's, not a project owner's", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const invite = await server.request<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({}) });
    await server.request("/api/auth/logout", { method: "POST" });
    // Joining through the invitation makes an owner of nothing and a member of one project.
    await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Alan",
        email: "alan@team.example.test",
        password: "another perfectly good password",
        inviteCode: invite.body.code,
      }),
    });

    const read = await readSettings(server);
    expect(read.response.status).toBe(403);
    const written = await writeSettings(server, { label: "mine now" });
    expect(written.response.status).toBe(403);

    // And the admin still can.
    await server.request("/api/auth/logout", { method: "POST" });
    await server.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect((await readSettings(server)).response.status).toBe(200);
  });

  it("lets the environment win, and says so rather than pretending the screen is live", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidc: provider.settings, oidcFetcher: provider.fetcher });
    await bootstrap(server);

    const read = await readSettings(server);
    expect(read.body.settings.source).toBe("environment");
    expect(read.body.settings.issuer).toBe(ISSUER);

    const refused = await writeSettings(server, { label: "something else" });
    expect(refused.response.status).toBe(409);
    expect((await readSettings(server)).body.settings.label).toBe("Authentik");
  });

  it("is closed to agent credentials, which never configure how people sign in", async () => {
    const provider = fakeProvider();
    const server = await startTestServer(undefined, { oidcFetcher: provider.fetcher });
    await bootstrap(server);
    const issued = await server.request<{ secret: string }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Planning agent", scope: "write" }),
    });

    const attempted = await fetch(`${server.baseUrl}/api/auth/oidc/settings`, {
      headers: { authorization: `Bearer ${issued.body.secret}` },
    });
    expect(attempted.status).toBe(403);
  });
});

describe("reading a provider out of the environment", () => {
  it("takes an issuer with or without a scheme or a trailing slash", () => {
    const base = { GRIMOIRE_OIDC_CLIENT_ID: "grimoire" };
    for (const issuer of ["https://id.example.com", "https://id.example.com/", "id.example.com"]) {
      const config = oidcConfigFromEnvironment({ ...base, GRIMOIRE_OIDC_ISSUER: issuer });
      expect(config?.issuer, issuer).toBe("https://id.example.com");
      expect(config?.label).toBe("id.example.com");
    }
  });

  it("defaults to auto-registration, and takes the operator's word over it", () => {
    const base = { GRIMOIRE_OIDC_ISSUER: "https://id.example.com", GRIMOIRE_OIDC_CLIENT_ID: "grimoire" };
    expect(oidcConfigFromEnvironment(base)?.autoRegister).toBe(true);
    expect(oidcConfigFromEnvironment({ ...base, GRIMOIRE_OIDC_AUTO_REGISTER: "false" })?.autoRegister).toBe(false);
    expect(oidcConfigFromEnvironment({ ...base, GRIMOIRE_OIDC_AUTO_REGISTER: "0" })?.autoRegister).toBe(false);
    expect(oidcConfigFromEnvironment({ ...base, GRIMOIRE_OIDC_AUTO_REGISTER: "yes" })?.autoRegister).toBe(true);
  });

  it("reads allowed domains however they were separated, and ignores a leading @", () => {
    const config = oidcConfigFromEnvironment({
      GRIMOIRE_OIDC_ISSUER: "https://id.example.com",
      GRIMOIRE_OIDC_CLIENT_ID: "grimoire",
      GRIMOIRE_OIDC_ALLOWED_EMAIL_DOMAINS: "@team.example.test, example.org",
    });
    expect(config?.allowedEmailDomains).toEqual(["team.example.test", "example.org"]);
  });
});

describe("who the allow list lets through", () => {
  it("lets anybody through when nobody said otherwise", () => {
    expect(emailAllowed("anyone@example.com", [])).toBe(true);
  });

  it("takes a domain, and its subdomains with it", () => {
    expect(emailAllowed("alan@team.example.test", ["team.example.test"])).toBe(true);
    expect(emailAllowed("alan@team.example.test", ["team.example.test"])).toBe(true);
    expect(emailAllowed("alan@example.com", ["team.example.test"])).toBe(false);
    // Not a suffix match on the raw string: "notteam.example.test" is somebody else's domain.
    expect(emailAllowed("alan@notteam.example.test", ["team.example.test"])).toBe(false);
  });

  it("takes one person, which is the only useful list for a personal provider account", () => {
    // Pointed at Google, the domain of a personal account is gmail.com - allowing that allows
    // everybody alive, so naming the two or three addresses is the list that means anything.
    const allowed = ["owner@example.com", "alan@team.example.test"];
    expect(emailAllowed("owner@example.com", allowed)).toBe(true);
    expect(emailAllowed("owner@example.com", allowed)).toBe(true);
    expect(emailAllowed("somebody.else@gmail.com", allowed)).toBe(false);
  });

  it("mixes the two, because an organisation with a couple of guests is the normal case", () => {
    const allowed = ["team.example.test", "owner@example.com"];
    expect(emailAllowed("anyone@team.example.test", allowed)).toBe(true);
    expect(emailAllowed("owner@example.com", allowed)).toBe(true);
    expect(emailAllowed("stranger@gmail.com", allowed)).toBe(false);
  });

  it("refuses a half-written configuration rather than starting without the button", () => {
    expect(oidcConfigFromEnvironment({})).toBeNull();
    expect(() => oidcConfigFromEnvironment({ GRIMOIRE_OIDC_ISSUER: "https://id.example.com" })).toThrow(/CLIENT_ID/);
    expect(() =>
      oidcConfigFromEnvironment({ GRIMOIRE_OIDC_ISSUER: "http://id.example.com", GRIMOIRE_OIDC_CLIENT_ID: "grimoire" }),
    ).toThrow(/https/);
    expect(() =>
      oidcConfigFromEnvironment({
        GRIMOIRE_OIDC_ISSUER: "https://id.example.com",
        GRIMOIRE_OIDC_CLIENT_ID: "grimoire",
        GRIMOIRE_OIDC_AUTO_REGISTER: "sometimes",
      }),
    ).toThrow(/true or false/);
  });
});
