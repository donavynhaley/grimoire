import { type FormEvent, useEffect, useState } from "react";
import type { AgentToken, AgentTokenScope } from "../../shared/types";
import { ApiError, agentTokens, issueAgentToken, revokeAgentToken } from "../api/client";
import { dayLabel } from "./chapter-dates";
import { useDialogEscape } from "./use-dialog-escape";

type Props = {
  onClose: () => void;
  /** Lets the settings summary say how many agents there are without fetching them itself. */
  onCountChange?: (count: number) => void;
};

/**
 * Where the owner hands something without a browser permission to write here.
 *
 * A credential acts as the person who issued it, so the list says whose name an agent's
 * work will carry. The secret is shown once and then genuinely gone: only its hash is
 * stored, and there is no route that can read it back.
 */
export function AgentAccessDialog({ onClose, onCountChange }: Props) {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AgentTokenScope>("write");
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const loaded = (await agentTokens()).tokens;
      setTokens(loaded);
      onCountChange?.(loaded.filter((token) => token.revokedAt === null).length);
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "Agent access could not be loaded");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (change: () => Promise<void>, failure: string) => {
    setError("");
    setBusy(true);
    try {
      await change();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      const created = await issueAgentToken({ name: trimmed, scope });
      setIssued(created);
      setCopied(false);
      setName("");
      await load();
    }, "The token could not be issued");
  };

  const revoke = (token: AgentToken) => {
    void run(async () => {
      await revokeAgentToken(token.id);
      setRevoking(null);
      if (issued?.token.id === token.id) setIssued(null);
      await load();
    }, "The token could not be revoked");
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
    } catch {
      // Selecting the text by hand still works, so a blocked clipboard is not an error.
      setCopied(false);
    }
  };

  useDialogEscape(onClose);

  const active = (tokens ?? []).filter((token) => token.revokedAt === null);
  const retired = (tokens ?? []).filter((token) => token.revokedAt !== null);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        aria-labelledby="agent-access-title"
        aria-modal="true"
        className="dialog-panel agent-dialog"
        role="dialog"
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">project settings</p>
            <h2 id="agent-access-title">Agent access</h2>
          </div>
          <button aria-label="Close agent access" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <p className="settings-summary agent-intro">
          A token lets an agent read this project, and write pages and ideas in it. It acts as you,
          so its work carries your name with the agent's beside it. It can never archive, promote an
          idea, or change the project's shape.
        </p>

        {issued && (
          <div className="agent-secret" role="status">
            <p className="field-label">{issued.token.name} · copy this now</p>
            <code className="agent-secret-value">{issued.secret}</code>
            <div className="agent-secret-actions">
              <button className="primary-button compact" onClick={() => void copy()} type="button">
                {copied ? "copied" : "copy"}
              </button>
              <button onClick={() => setIssued(null)} type="button">done</button>
            </div>
            <p className="settings-summary">This is the only time it is shown. Only its hash is stored.</p>
          </div>
        )}

        <form className="agent-create" onSubmit={submit}>
          <div className="settings-input">
            <label className="sr-only" htmlFor="agent-name">Agent name</label>
            <input
              id="agent-name"
              name="agentName"
              onChange={(event) => setName(event.target.value)}
              placeholder="Planning agent"
              value={name}
            />
            <label className="sr-only" htmlFor="agent-scope">What it may do</label>
            <select
              id="agent-scope"
              name="agentScope"
              onChange={(event) => setScope(event.target.value as AgentTokenScope)}
              value={scope}
            >
              <option value="write">read and write</option>
              <option value="read">read only</option>
            </select>
            <button className="primary-button compact" disabled={busy || !name.trim()} type="submit">issue</button>
          </div>
        </form>

        {tokens === null ? (
          <p className="settings-summary">Loading…</p>
        ) : active.length === 0 ? (
          <p className="settings-summary">No agent has access to this project.</p>
        ) : (
          <ul className="agent-list">
            {active.map((token) => (
              <li className="agent-row" key={token.id}>
                <div className="agent-row-main">
                  <span className="agent-name">{token.name}</span>
                  <span className="agent-meta">
                    {token.scope === "write" ? "read and write" : "read only"} · acts as {token.ownerName} ·{" "}
                    {token.lastUsedAt ? `last used ${dayLabel(token.lastUsedAt.slice(0, 10))}` : "never used"}
                  </span>
                </div>
                {revoking === token.id ? (
                  <span className="archive-confirm">
                    <span>revoke {token.name}?</span>
                    <button className="danger-text" disabled={busy} onClick={() => revoke(token)} type="button">yes</button>
                    <button onClick={() => setRevoking(null)} type="button">no</button>
                  </span>
                ) : (
                  <button className="danger-text" onClick={() => setRevoking(token.id)} type="button">revoke</button>
                )}
              </li>
            ))}
          </ul>
        )}

        {retired.length > 0 && (
          <p className="settings-summary agent-retired">
            {retired.length} revoked · their past work still says which agent wrote it.
          </p>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
