import { type FormEvent, useEffect, useState } from "react";
import type { AgentToken, AgentTokenScope } from "../../shared/types";
import { agentTokenIsLive, agentTokens, issueAgentToken, revokeAgentToken } from "../api/client";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";
import { dayLabel } from "../lib/chapter-dates";
import type { SettingsRun } from "../hooks/use-settings-action";

type Props = {
  run: SettingsRun;
};

/**
 * Where the owner hands something without a browser permission to write here.
 *
 * A credential acts as the person who issued it, so the list says whose name an agent's
 * work will carry. The secret is shown once and then genuinely gone: only its hash is
 * stored, and there is no route that can read it back.
 */
export function AgentAccessSection({ run }: Props) {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  // A failed load is said out loud. Showing the empty-state copy instead would present
  // "no agent has access" as a fact nobody checked.
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AgentTokenScope>("write");
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setTokens((await agentTokens()).tokens);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    // The guard every other loader in the settings dialog carries: a load racing
    // the dialog closing must not write state into an unmounted section.
    let alive = true;
    void (async () => {
      try {
        const loaded = await agentTokens();
        if (!alive) return;
        setTokens(loaded.tokens);
        setLoadFailed(false);
      } catch {
        if (alive) setLoadFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const act = async (change: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await run(change, failure);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void act(async () => {
      const created = await issueAgentToken({ name: trimmed, scope });
      setIssued(created);
      setCopied(false);
      setName("");
      await load();
    }, "The token could not be issued");
  };

  const revoke = (token: AgentToken) => {
    void act(async () => {
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

  // Expired counts as retired: the server refuses it exactly like a revoked one, so
  // listing it as live would offer a revoke button on a thing that already stopped.
  const active = (tokens ?? []).filter((token) => agentTokenIsLive(token));
  const retired = (tokens ?? []).filter((token) => !agentTokenIsLive(token));

  return (
    <Growing className="settings-section">
      <p className="settings-summary agent-intro">
        A token lets an agent read this project, and write pages and ideas in it. It acts as you, so its work
        carries your name with the agent's beside it. It can never archive, promote an idea, or change the
        project's shape.
      </p>

      {issued && (
        <div className="agent-secret" role="status">
          <p className="field-label">{issued.token.name} · copy this now</p>
          <code className="agent-secret-value">{issued.secret}</code>
          <div className="agent-secret-actions">
            <button className="primary-button compact" onClick={() => void copy()} type="button">
              {copied ? "copied" : "copy"}
            </button>
            <button onClick={() => setIssued(null)} type="button">
              done
            </button>
          </div>
          <p className="settings-summary">This is the only time it is shown. Only its hash is stored.</p>
        </div>
      )}

      <form className="agent-create" onSubmit={submit}>
        <div className="settings-input">
          <label className="sr-only" htmlFor="agent-name">
            Agent name
          </label>
          <input
            id="agent-name"
            name="agentName"
            onChange={(event) => setName(event.target.value)}
            placeholder="Planning agent"
            value={name}
          />
          <label className="sr-only" htmlFor="agent-scope">
            What it may do
          </label>
          <select
            id="agent-scope"
            name="agentScope"
            onChange={(event) => setScope(event.target.value as AgentTokenScope)}
            value={scope}
          >
            <option value="write">read and write</option>
            <option value="read">read only</option>
          </select>
          <button className="primary-button compact" disabled={busy || !name.trim()} type="submit">
            issue
          </button>
        </div>
      </form>

      {loadFailed ? (
        <p className="settings-summary agent-load-failed">
          Agent access could not be loaded, so this list may be incomplete.{" "}
          <button className="text-button" onClick={() => void load()} type="button">
            retry
          </button>
        </p>
      ) : tokens === null ? (
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
              <ConfirmInline
                className="archive-confirm"
                confirmDisabled={busy}
                onCancel={() => setRevoking(null)}
                onConfirm={() => revoke(token)}
                onOpen={() => setRevoking(token.id)}
                open={revoking === token.id}
                question={`revoke ${token.name}?`}
                trigger="revoke"
                triggerClass="danger-text"
              />
            </li>
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <p className="settings-summary agent-retired">
          {retired.length} revoked or expired · their past work still says which agent wrote it.
        </p>
      )}
    </Growing>
  );
}
