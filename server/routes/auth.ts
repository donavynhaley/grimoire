import { randomUUID } from "node:crypto";
import type { User } from "../../shared/types";
import { AVATAR_SIZE_LIMIT, sniffAvatarType } from "../avatars";
import { withTransaction } from "../database";
import { createGettingStartedProject, GETTING_STARTED_NAME } from "../getting-started";
import {
  appendCookie,
  HttpError,
  json,
  oidcMessage,
  readCookie,
  readJson,
  readRaw,
  redirectToSignIn,
  requestClientId,
} from "../http";
import { clientAddress } from "../login-rate-limit";
import {
  DEFAULT_SCOPES as DEFAULT_OIDC_SCOPES,
  newSignInSecrets,
  OidcError,
  type OidcIdentity,
  parseIssuerInput,
  providerBrand,
  safeReturnPath,
} from "../oidc";
import { oidcSettingsView, saveOidcSettings } from "../oidc-settings";
import {
  defaultProjectIdForUser,
  findUserByEmail,
  findUserById,
  publicUser,
  userCount,
} from "../repository/users";
import {
  accountSchema,
  displayNameSchema,
  loginSchema,
  oidcProbeSchema,
  oidcSettingsSchema,
  passwordChangeSchema,
  registerSchema,
} from "../schemas";
import { hashPassword, hashToken, verifyPassword } from "../security";
import { type AppContext, requireAdmin, requireUser } from "./context";
import type { Route } from "./route";

/**
 * Ties a provider callback to the browser that started the flow.
 *
 * Scoped to the callback route so it is sent on exactly one request, and `SameSite=Lax` rather
 * than `Strict` because the browser arrives back here from the provider's origin and a strict
 * cookie would not be sent on that navigation at all.
 */
const OIDC_STATE_COOKIE = "grimoire_oidc_state";

/** Every door into a session, and the account routes that manage what a session holds. */
export function authRoutes(app: AppContext): Route[] {
  const { database, avatarStore, auth, pageStore, chapterStore } = app;
  return [
    {
      method: "GET",
      pattern: "/api/health",
      handler: (context) => {
        json(context.response, 200, { ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/session",
      handler: (context) => {
        // What the sign-in screen needs to know before anybody has signed in: whether there is
        // a second door, and what to call it. Nothing here is a secret - the client id and the
        // provider's name are both public parts of the flow.
        const configured = auth.currentOidc().config;
        const brand = configured ? providerBrand(configured.issuer) : null;
        const signInOptions = configured
          ? { oidc: { label: configured.label, ...(brand ? { brand } : {}) } }
          : {};
        if (userCount(database) === 0) {
          json(context.response, 200, { status: "setup_required", ...signInOptions });
        } else if (!context.user) {
          json(context.response, 200, { status: "anonymous", ...signInOptions });
        } else {
          json(context.response, 200, {
            status: "authenticated",
            user: app.withAvatar(context.user),
            ...signInOptions,
            // Tells a credential what it is, so an agent client can shape its own surface -
            // a read-only agent that knows its scope never offers itself a write tool.
            ...(context.agent ? { agent: { name: context.agent.name, scope: context.agent.scope } } : {}),
          });
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/bootstrap",
      handler: async (context) => {
        if (userCount(database) !== 0) throw new HttpError(409, "Setup is already complete");
        const input = accountSchema.parse(await readJson(context.request));
        const userId = randomUUID();
        const now = new Date().toISOString();
        const passwordHash = await hashPassword(input.password);
        // The one admin this installation ever has: whoever stood it up. Nothing grants the
        // role afterwards and nothing takes it away, which is what makes it the account that
        // can never be locked out of its own instance. "One, ever" is enforced by the INSERT
        // itself rather than by the check above, because that check and this write are
        // separated by two awaits - two racing setup requests would both pass it.
        const inserted = database
          .prepare(
            `INSERT INTO users (id, name, email, password_hash, role, created_at)
             SELECT ?, ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
          )
          .run(userId, input.name, input.email, passwordHash, now);
        if (Number(inserted.changes) !== 1) throw new HttpError(409, "Setup is already complete");
        let projectId: string;
        try {
          projectId = createGettingStartedProject(database, pageStore, chapterStore, userId);
        } catch (error) {
          database.prepare("DELETE FROM users WHERE id = ?").run(userId);
          throw error;
        }
        const user = app.withAvatar(publicUser(findUserById(database, userId)!));
        auditJoin(app, user, projectId, { projectCreated: true });
        auth.setSession(context.response, userId);
        json(context.response, 201, { user });
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/login",
      handler: async (context) => {
        const input = loginSchema.parse(await readJson(context.request));
        const address = clientAddress(context.request, auth.trustProxy);
        // Checked before the password is verified, so a refused attempt costs a comparison
        // rather than the deliberately slow hash the password itself is worth.
        const exhausted = !auth.addressLimiter.allows(address) || !auth.accountLimiter.allows(input.email);
        if (exhausted) {
          const wait = Math.max(
            auth.addressLimiter.retryAfterSeconds(address),
            auth.accountLimiter.retryAfterSeconds(input.email),
          );
          context.response.setHeader("Retry-After", String(wait));
          throw new HttpError(429, "Too many sign-in attempts. Try again shortly.");
        }
        const stored = findUserByEmail(database, input.email);
        const passwordMatches = stored
          ? await verifyPassword(input.password, String(stored.password_hash))
          : await verifyPassword(input.password, await auth.placeholderPasswordHash);
        const projectId = stored ? defaultProjectIdForUser(database, publicUser(stored)) : null;
        if (!stored || !passwordMatches || !projectId) {
          auth.addressLimiter.spend(address);
          auth.accountLimiter.spend(input.email);
          throw new HttpError(401, "Email or password is incorrect");
        }
        // A right answer is not a guess, so it clears what the wrong ones before it cost.
        auth.addressLimiter.forget(address);
        auth.accountLimiter.forget(input.email);
        const user = app.withAvatar(publicUser(stored));
        auth.setSession(context.response, user.id);
        json(context.response, 200, { user });
      },
    },
    {
      method: "GET",
      pattern: "/api/auth/oidc",
      handler: async (context) => {
        const { config: oidcConfig } = auth.currentOidc();
        if (!oidcConfig) throw new HttpError(404, "No sign-in provider is configured");
        const oidc = auth.oidcProviders.for(oidcConfig);
        const secrets = newSignInSecrets();
        const redirectUri = auth.oidcRedirectUri(context.request, context.url, oidcConfig);
        const invite = context.url.searchParams.get("invite");
        auth.pendingSignIns.open({
          state: secrets.state,
          verifier: secrets.verifier,
          nonce: secrets.nonce,
          redirectUri,
          invite: invite && invite.length <= 200 ? invite : null,
          returnTo: safeReturnPath(context.url.searchParams.get("return")),
        });
        let destination: string;
        try {
          destination = await oidc.authorizationUrl({ redirectUri, ...secrets });
        } catch (error) {
          redirectToSignIn(context.response, "/", oidcMessage(error));
          return;
        }
        // The state also rides in a cookie, so a callback has to arrive in the same browser that
        // started the flow. Without it an attacker who completed their own sign-in could hand
        // somebody a callback link and quietly land them in the attacker's account.
        appendCookie(
          context.response,
          `${OIDC_STATE_COOKIE}=${secrets.state}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600${app.options.production ? "; Secure" : ""}`,
        );
        context.response.statusCode = 302;
        context.response.setHeader("Location", destination);
        context.response.setHeader("Cache-Control", "no-store");
        context.response.end();
      },
    },
    {
      method: "GET",
      pattern: "/api/auth/oidc/callback",
      handler: async (context) => {
        const { config: oidcConfig } = auth.currentOidc();
        if (!oidcConfig) throw new HttpError(404, "No sign-in provider is configured");
        const oidc = auth.oidcProviders.for(oidcConfig);
        appendCookie(
          context.response,
          `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0${app.options.production ? "; Secure" : ""}`,
        );
        const state = context.url.searchParams.get("state") ?? "";
        const cookieState = readCookie(context.request, OIDC_STATE_COOKIE);
        const pending = state && cookieState === state ? auth.pendingSignIns.claim(state) : null;
        if (!pending) {
          redirectToSignIn(context.response, "/", "That sign-in has expired. Try again.");
          return;
        }
        // The provider says no by redirecting back with a reason rather than by failing.
        const refusal = context.url.searchParams.get("error");
        if (refusal) {
          redirectToSignIn(
            context.response,
            pending.returnTo,
            `The sign-in provider refused the request (${refusal}).`,
          );
          return;
        }
        const code = context.url.searchParams.get("code");
        if (!code) {
          redirectToSignIn(
            context.response,
            pending.returnTo,
            "The sign-in provider returned no authorization code.",
          );
          return;
        }

        let identity: OidcIdentity;
        try {
          identity = await oidc.identify({
            code,
            redirectUri: pending.redirectUri,
            verifier: pending.verifier,
            nonce: pending.nonce,
          });
        } catch (error) {
          redirectToSignIn(context.response, pending.returnTo, oidcMessage(error));
          return;
        }

        let signedIn: User;
        try {
          signedIn = await auth.signInWithIdentity(identity, pending.invite, oidcConfig);
        } catch (error) {
          if (error instanceof HttpError) {
            redirectToSignIn(context.response, pending.returnTo, error.message);
            return;
          }
          throw error;
        }
        auth.setSession(context.response, signedIn.id);
        context.response.statusCode = 302;
        context.response.setHeader("Location", pending.returnTo);
        context.response.setHeader("Cache-Control", "no-store");
        context.response.end();
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/logout",
      handler: (context) => {
        if (context.sessionToken) {
          database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(context.sessionToken));
        }
        auth.clearSession(context.response);
        json(context.response, 200, { ok: true });
      },
    },
    /*
     * Setting the provider up, from a screen rather than from a redeploy.
     *
     * All three are the installation admin's, not a project owner's: there is one provider
     * for the whole installation, the way there is one admin, and a project owner reshaping
     * their own board has no business deciding how everybody signs in to all of them.
     */
    {
      method: "GET",
      pattern: "/api/auth/oidc/settings",
      handler: (context) => {
        requireAdmin(context);
        json(context.response, 200, {
          settings: oidcSettingsView(
            database,
            auth.environmentOidc,
            auth.oidcRedirectUri(context.request, context.url, null),
          ),
        });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/auth/oidc/settings",
      handler: async (context) => {
        const user = requireAdmin(context);
        if (auth.environmentOidc) {
          throw new HttpError(409, "This provider is set in the environment, so it is changed there.");
        }
        const input = oidcSettingsSchema.parse(await readJson(context.request));
        if (input.issuer !== undefined && input.issuer !== "") {
          const parsed = parseIssuerInput(input.issuer);
          if ("error" in parsed) throw new HttpError(400, `The provider address ${parsed.error}`);
        }
        saveOidcSettings(database, input, user.id);
        app.audit(context, {
          projectId: defaultProjectIdForUser(database, user) ?? "",
          entityType: "member",
          entityId: user.id,
          entityTitle: "single sign-on",
          action: "updated",
        });
        json(context.response, 200, {
          settings: oidcSettingsView(
            database,
            auth.environmentOidc,
            auth.oidcRedirectUri(context.request, context.url, null),
          ),
        });
      },
    },
    /*
     * Ask a provider to describe itself, before anything is saved.
     *
     * This is the auto-populate button and the check button at once: the same call fills the
     * screen in and says whether the address works. It answers about the provider, never about
     * the client id and secret, because nothing short of an actual sign-in exercises those -
     * and a check that implied otherwise would be worse than no check.
     */
    {
      method: "POST",
      pattern: "/api/auth/oidc/probe",
      handler: async (context) => {
        requireAdmin(context);
        const input = oidcProbeSchema.parse(await readJson(context.request));
        const parsed = parseIssuerInput(input.issuer);
        if ("error" in parsed) throw new HttpError(400, `The provider address ${parsed.error}`);
        const probe = auth.oidcProviders.probe({
          issuer: parsed.issuer,
          clientId: input.clientId ?? "grimoire",
          clientSecret: "",
          redirectUri: null,
          scopes: DEFAULT_OIDC_SCOPES,
          label: parsed.hostname,
          autoRegister: true,
          allowedEmailDomains: [],
          signupProject: null,
        });
        try {
          json(context.response, 200, { provider: await probe.describe() });
        } catch (error) {
          // A failed probe is an upstream failure and answers like one - this was the one
          // route in the product that said no with a 200.
          if (error instanceof OidcError) throw new HttpError(502, error.message);
          console.error("oidc probe failed", error);
          throw new HttpError(502, "That address could not be reached from the server.");
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/account/password",
      handler: async (context) => {
        const user = requireUser(context);
        const input = passwordChangeSchema.parse(await readJson(context.request));
        const stored = findUserById(database, user.id)!;
        if (!(await verifyPassword(input.currentPassword, String(stored.password_hash)))) {
          throw new HttpError(401, "Current password is incorrect");
        }
        const passwordHash = await hashPassword(input.newPassword);
        withTransaction(database, () => {
          database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
          if (context.sessionToken) {
            database
              .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
              .run(user.id, hashToken(context.sessionToken));
          }
        });
        json(context.response, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/account/name",
      handler: async (context) => {
        const user = requireUser(context);
        // Resolved before the reply goes out: requireProject can refuse, and a refusal
        // after json() has answered is a success the client saw and a 500 in the log
        // that nothing can be correlated with.
        const projectId = app.requireProject(context, user);
        const input = displayNameSchema.parse(await readJson(context.request));
        database.prepare("UPDATE users SET name = ? WHERE id = ?").run(input.name, user.id);
        const updated = app.withAvatar(publicUser(findUserById(database, user.id)!));
        json(context.response, 200, { user: updated });
        // Names are joined in at read time, so every card byline, idea, and member face is stale.
        app.broadcast(projectId, "both", requestClientId(context.request));
      },
    },
    {
      method: "PUT",
      pattern: "/api/account/avatar",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const data = await readRaw(context.request, AVATAR_SIZE_LIMIT);
        const imageType = sniffAvatarType(data);
        if (!imageType) throw new HttpError(400, "Profile picture must be a PNG, JPEG, or WebP image");
        avatarStore.save(user.id, data, imageType);
        json(context.response, 200, { avatarUrl: avatarStore.urlFor(user.id) });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: "/api/account/avatar",
      handler: (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        avatarStore.remove(user.id);
        json(context.response, 200, { ok: true });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/register",
      handler: async (context) => {
        const input = registerSchema.parse(await readJson(context.request));
        // The same judgement the OIDC sign-up path makes, through the same helper - the
        // route used to restate it inline, which is how the two doors drift apart.
        const invite = auth.findUsableInvite(input.inviteCode);
        if (!invite) throw new HttpError(409, "Invitation is invalid or has already been used");
        if (findUserByEmail(database, input.email)) {
          throw new HttpError(409, "An account already uses this email");
        }
        const projectId = String(invite.project_id);
        const userId = randomUUID();
        const now = new Date().toISOString();
        const passwordHash = await hashPassword(input.password);

        withTransaction(database, () => {
          database
            .prepare(
              "INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)",
            )
            .run(userId, input.name, input.email, passwordHash, now);
          database
            .prepare(
              "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
            )
            .run(projectId, userId, now);
          const update = database
            .prepare("UPDATE invites SET used_by = ? WHERE id = ? AND used_by IS NULL")
            .run(userId, String(invite.id));
          if (Number(update.changes) !== 1) throw new HttpError(409, "Invitation has already been used");
        });
        const user = app.withAvatar(publicUser(findUserById(database, userId)!));
        auditJoin(app, user, projectId, { projectCreated: false });
        auth.setSession(context.response, userId);
        json(context.response, 201, { user });
        app.broadcast(projectId, "work", null);
      },
    },
  ];
}

/** The joining entries both doors write; bootstrap also records the project it just made. */
function auditJoin(
  app: AppContext,
  user: User,
  projectId: string,
  options: { projectCreated: boolean },
): void {
  if (options.projectCreated) {
    app.auditAs(user, {
      projectId,
      entityType: "project",
      entityId: projectId,
      entityTitle: GETTING_STARTED_NAME,
      action: "created",
    });
  }
  app.auditAs(user, {
    projectId,
    entityType: "member",
    entityId: user.id,
    entityTitle: user.name,
    action: "joined",
  });
}
