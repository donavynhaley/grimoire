// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OidcSettings } from "../../shared/types";
import { SignInSection } from "../../src/components/SignInSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function settings(overrides: Partial<OidcSettings> = {}): OidcSettings {
  return {
    source: "none",
    enabled: false,
    issuer: "",
    clientId: "",
    clientSecretSet: false,
    scopes: "",
    label: "",
    autoRegister: true,
    allowedEmailDomains: "",
    redirectUri: "",
    signupProject: "",
    callbackUrl: "https://grimoire.example.com/api/auth/oidc/callback",
    linkedAccounts: 0,
    updatedAt: null,
    ...overrides,
  };
}

/** Stands the section up against a server that answers exactly what the test wants it to. */
function mount(options: { settings?: Partial<OidcSettings>; probe?: unknown } = {}) {
  const saved: Array<Record<string, unknown>> = [];
  let current = settings(options.settings);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.startsWith("/api/auth/oidc/probe"))
      return response(options.probe ?? { error: "not configured for this test" });
    if (url.startsWith("/api/auth/oidc/settings")) {
      if (init.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved.push(body);
        current = { ...current, ...(body as Partial<OidcSettings>) };
        return response({ settings: current });
      }
      return response({ settings: current });
    }
    return response({}, 404);
  });
  const run = vi.fn(async (action: () => Promise<void>) => {
    await action();
  });
  render(<SignInSection run={run} />);
  return { saved };
}

describe("the sign-in settings screen", () => {
  it("shows the address this browser is actually reaching Grimoire at, ready to copy", async () => {
    mount();
    // Not the server's guess at its own public address, which is what a proxy makes unknowable
    // and which is the one value these setups get wrong more than any other.
    expect(await screen.findByText(`${location.origin}/api/auth/oidc/callback`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument();
  });

  it("pins that address the first time anything is saved, so the two can never drift", async () => {
    const { saved } = mount();

    await userEvent.type(await screen.findByLabelText("Client id"), "grimoire");
    await userEvent.tab();

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.redirectUri).toBe(`${location.origin}/api/auth/oidc/callback`);
  });

  it("leaves an address that is already pinned alone", async () => {
    const { saved } = mount({
      settings: { redirectUri: "https://grimoire.example.com/api/auth/oidc/callback" },
    });

    expect(
      await screen.findByText("https://grimoire.example.com/api/auth/oidc/callback"),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Client id"), "grimoire");
    await userEvent.tab();

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).not.toHaveProperty("redirectUri");
  });

  it("reads the provider's own configuration instead of asking for seven URLs", async () => {
    mount({
      probe: {
        provider: {
          issuer: "https://id.example.com",
          discoveryUrl: "https://id.example.com/.well-known/openid-configuration",
          authorizationEndpoint: "https://id.example.com/authorize",
          tokenEndpoint: "https://id.example.com/token",
          userinfoEndpoint: "https://id.example.com/userinfo",
          jwksUri: "https://id.example.com/jwks",
          signingAlgorithms: ["RS256"],
          supportsPkce: true,
          scopesSupported: ["openid", "email"],
          signingKeyCount: 2,
        },
      },
    });

    await userEvent.type(await screen.findByLabelText("Provider address"), "https://id.example.com");
    await userEvent.click(screen.getByRole("button", { name: "check" }));

    expect(await screen.findByText(/Answered as https:\/\/id\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/2 signing keys published/)).toBeInTheDocument();
    expect(screen.getByText(/PKCE supported/)).toBeInTheDocument();
    // It says what it did not check, rather than letting a tick imply the client is right too.
    expect(screen.getByText(/cannot check the client id and secret/i)).toBeInTheDocument();
  });

  it("says what went wrong, in the screen, when the address is not a provider", async () => {
    mount({ probe: { error: "No provider configuration at https://nope.example.com (404)." } });

    await userEvent.type(await screen.findByLabelText("Provider address"), "https://nope.example.com");
    await userEvent.click(screen.getByRole("button", { name: "check" }));

    expect(await screen.findByText(/No provider configuration at/)).toBeInTheDocument();
  });

  it("cannot be turned on while it would offer a button that goes nowhere", async () => {
    mount({ settings: { issuer: "https://id.example.com" } });
    const toggle = await screen.findByRole("checkbox", { name: /offered|off/i });
    expect(toggle).toBeDisabled();
  });

  it("turns on once there is a provider and a client to be", async () => {
    mount({ settings: { issuer: "https://id.example.com", clientId: "grimoire" } });
    const toggle = await screen.findByRole("checkbox", { name: /offered|off/i });
    expect(toggle).toBeEnabled();
  });

  it("says a secret is held without ever showing it", async () => {
    mount({ settings: { clientSecretSet: true } });
    const secret = (await screen.findByLabelText("Client secret")) as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toMatch(/A secret is saved/);
  });

  it("reads but does not pretend to edit a provider set in the environment", async () => {
    mount({
      settings: {
        source: "environment",
        enabled: true,
        issuer: "https://id.example.com",
        clientId: "grimoire",
        label: "Authentik",
      },
    });

    expect(await screen.findByText(/configured in the environment/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Provider address")).toBeDisabled();
    expect(screen.getByLabelText("Client id")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "check" })).not.toBeInTheDocument();
  });

  it("explains what auto-registration means either way round", async () => {
    mount({ settings: { autoRegister: true } });
    expect(await screen.findByText(/They join on first sign-in/)).toBeInTheDocument();
    expect(screen.getByText(/matched by email, not replaced/)).toBeInTheDocument();
  });

  it("saves each field as it is left, without forgetting the secret it was not given", async () => {
    const { saved } = mount({ settings: { issuer: "https://id.example.com", clientSecretSet: true } });

    const clientId = await screen.findByLabelText("Client id");
    await userEvent.type(clientId, "grimoire");
    await userEvent.tab();

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ clientId: "grimoire" });
    // Nothing about the secret travelled, so the server keeps the one it holds.
    expect(saved[0]).not.toHaveProperty("clientSecret");
  });
});
