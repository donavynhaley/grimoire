import { FormEvent, useState } from "react";
import type { User } from "../../shared/types";
import { ApiError, mutate } from "../api/client";

type Props = {
  mode: "setup" | "login" | "register";
  inviteCode?: string;
  onAuthenticated: (user: User) => Promise<void>;
};

export function AuthScreen({ mode: initialMode, inviteCode, onAuthenticated }: Props) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <span className="brand-mark">g</span>
        <span>grimoire</span>
      </div>
      <main className="auth-card">
        <p className="eyebrow">{setup ? "first run" : register ? "project invitation" : "wizard simulator"}</p>
        <h1>{setup ? "Create your Grimoire" : register ? "Join the project" : "Welcome back"}</h1>
        <p className="auth-copy">
          {setup
            ? "Create the owner account for your private Wizard Simulator workspace."
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
