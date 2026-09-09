import { type FormEvent, useState } from "react";
import type { SignInProviders, User } from "../../shared/types";
import { ApiError, mutate } from "../api/client";

type Props = {
  mode: "setup" | "login" | "register";
  inviteCode?: string;
  onAuthenticated: (user: User) => Promise<void>;
  /** The identity provider this installation offers, when it offers one. */
  oidc?: SignInProviders["oidc"];
  /** Why a provider sign-in that was already attempted came back without a session. */
  providerError?: string;
};

/**
 * Google's mark, unmodified.
 *
 * Reproduced at the proportions and colours Google publishes, because those are the terms on
 * which it may be shown at all: it may not be recoloured, flattened to one colour, or drawn
 * from memory. Inline rather than an image file so it is one fewer request and cannot be
 * broken by a caching layer, which for a sign-in button is a mark that silently disappears.
 */
function GoogleMark() {
  return (
    <svg aria-hidden="true" height="18" viewBox="0 0 48 48" width="18">
      <path
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        fill="#EA4335"
      />
      <path
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        fill="#4285F4"
      />
      <path
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        fill="#FBBC05"
      />
      <path
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        fill="#34A853"
      />
    </svg>
  );
}

export function AuthScreen({ mode: initialMode, inviteCode, onAuthenticated, oidc, providerError }: Props) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(providerError ?? "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const path =
        mode === "setup"
          ? "/api/auth/bootstrap"
          : mode === "register"
            ? "/api/auth/register"
            : "/api/auth/login";
      const body = mode === "login" ? { email, password } : { name, email, password, inviteCode };
      const result = await mutate<{ user: User }>(path, "POST", body);
      await onAuthenticated(result.user);
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "Could not connect to Grimoire");
    } finally {
      setBusy(false);
    }
  };

  const setup = mode === "setup";
  const register = mode === "register";

  /**
   * The provider flow is a navigation rather than a request, so it is a link.
   *
   * It carries where to come back to, so signing in from a link to a particular page lands on
   * that page, and the invitation when there is one, which is the only way a provider sign-in
   * can create an account on an installation nobody has invited the person to.
   */
  const providerHref = () => {
    const current = new URLSearchParams(location.search);
    current.delete("signin_error");
    const query = new URLSearchParams({ return: `${location.pathname}${current.size ? `?${current}` : ""}` });
    if (inviteCode) query.set("invite", inviteCode);
    return `/api/auth/oidc?${query}`;
  };

  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <span className="brand-mark">g</span>
        <span>grimoire</span>
      </div>
      <main className="auth-card">
        {/* Signed out there is no project to name yet, so each eyebrow names the step instead. */}
        <p className="eyebrow">{setup ? "first run" : register ? "project invitation" : "sign in"}</p>
        <h1>{setup ? "Create your Grimoire" : register ? "Join the project" : "Welcome back"}</h1>
        <p className="auth-copy">
          {setup
            ? "Create the owner account for your private Grimoire workspace."
            : register
              ? "Create your account to join the shared project board."
              : "Sign in to see the board and what everyone is working on."}
        </p>
        <form className="stack-form" onSubmit={submit}>
          {mode !== "login" && (
            <label>
              <span>Your name</span>
              <input
                autoComplete="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
          )}
          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              name="email"
              placeholder="you@example.com"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              name="password"
              minLength={12}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {mode !== "login" && <small>Use at least 12 characters.</small>}
          </label>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "working..." : setup ? "create workspace" : register ? "join project" : "sign in"}
          </button>
        </form>
        {/* Setup has no provider button: the first account is the one that can never be
            locked out, and it is only ever the account somebody makes here with a password. */}
        {oidc && !setup && (
          <>
            <p className="auth-divider">
              <span>or</span>
            </p>
            {oidc.brand === "google" ? (
              <a className="google-button" href={providerHref()}>
                <GoogleMark />
                <span>Sign in with Google</span>
              </a>
            ) : (
              <a className="provider-button" href={providerHref()}>
                continue with {oidc.label}
              </a>
            )}
          </>
        )}
        {!setup && !register && (
          <p className="auth-footnote">
            Accounts are invitation-only. Ask the project owner for an invite link.
          </p>
        )}
        <a className="demo-entry quiet-button" href="/demo">
          Try the demo
        </a>
        {register && (
          <button className="text-button" onClick={() => setMode("login")} type="button">
            already joined? sign in
          </button>
        )}
      </main>
    </div>
  );
}
