import { generateKeyPairSync, sign as signWith, type KeyObject } from "node:crypto";
import type { OidcConfig, OidcFetcher } from "../../server/oidc";

export const ISSUER = "https://id.example.com";

const config: OidcConfig = {
  issuer: ISSUER,
  clientId: "grimoire",
  clientSecret: "a shared secret",
  redirectUri: null,
  scopes: ["openid", "email", "profile"],
  label: "Authentik",
  // Off in the shared configuration so the invitation path is what most tests exercise; the
  // shipped default is on, and the test below holds it to that.
  autoRegister: false,
  allowedEmailDomains: [],
  signupProject: null,
};

/**
 * A provider that signs real tokens with a real key.
 *
 * The point of standing one of these up rather than stubbing the verification is that every
 * refusal below is the actual signature and claim checking answering, so a change that quietly
 * stopped verifying would fail here rather than pass.
 */
export function fakeProvider(options: { config?: Partial<OidcConfig> } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // A second key that is never published, so a token signed with it is what a forgery or a
  // relayed token from somewhere else looks like on the wire.
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "test-key",
    alg: "RS256",
  };
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
        body: {
          id_token: idToken(registered.claims, registered.forged),
          access_token: "provider-access-token",
        },
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
