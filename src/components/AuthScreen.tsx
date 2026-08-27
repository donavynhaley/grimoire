import { FormEvent, useState } from "react";
import { DEFAULT_OWNER_EMAIL } from "../../shared/config";
import type { User } from "../../shared/types";
import { ApiError, mutate } from "../api/client";

type Props = {
  mode: "setup" | "login" | "register";
  inviteCode?: string;
  onAuthenticated: (user: User) => Promise<void>;
  /** The identity provider this installation offers, when it offers one. */
  oidc?: { label: string };
  /** Why a provider sign-in that was already attempted came back without a session. */
  providerError?: string;
};

export function AuthScreen({ mode: initialMode, inviteCode, onAuthenticated, oidc, providerError }: Props) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialMode === "setup" ? DEFAULT_OWNER_EMAIL : "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(providerError ?? "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const path =
        mode === "setup" ? "/api/auth/bootstrap" : mode === "register" ? "/api/auth/register" : "/api/auth/login";
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
              <input autoComplete="name" name="name" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
          )}
          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              name="email"
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
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "working..." : setup ? "create workspace" : register ? "join project" : "sign in"}
          </button>
        </form>
        {/* Setup has no provider button: the first account is the one that can never be
            locked out, and it is only ever the account somebody makes here with a password. */}
        {oidc && !setup && (
          <>
            <p className="auth-divider"><span>or</span></p>
            <a className="provider-button" href={providerHref()}>
              continue with {oidc.label}
            </a>
          </>
        )}
        {!setup && !register && (
          <p className="auth-footnote">Accounts are invitation-only. Ask the project owner for an invite link.</p>
        )}
        {register && (
          <button className="text-button" onClick={() => setMode("login")} type="button">
            already joined? sign in
          </button>
        )}
      </main>
    </div>
  );
}
