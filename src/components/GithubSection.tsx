import { useState } from "react";
import { verifyGithub, type GithubVerification } from "../api/client";
import { Growing } from "./Growing";
import type { SettingsRun } from "../hooks/use-settings-action";

/**
 * Where a project says which repository its pull requests live in.
 *
 * The token is write-only from here: the form can tell one is held and can replace or clear
 * it, but never reads it back, because a secret that round-trips to a browser is not one.
 */
export function GithubSection({
  busy,
  project,
  onSetRepo,
  onSetToken,
  run,
}: {
  busy: boolean;
  project: { githubRepo: string; githubTokenSet: boolean };
  onSetRepo: (repo: string) => Promise<void>;
  onSetToken: (token: string) => Promise<void>;
  run: SettingsRun;
}) {
  const [repoDraft, setRepoDraft] = useState<string | undefined>(undefined);
  const repo = repoDraft ?? project.githubRepo;
  const [token, setToken] = useState("");
  const [verdict, setVerdict] = useState<GithubVerification | "checking" | null>(null);
  // Open on arrival only while nothing is configured, which is exactly when it is needed.
  const [showingSetup, setShowingSetup] = useState(!project.githubRepo);

  const saveRepo = () => {
    const next = repo.trim();
    if (next === project.githubRepo) return;
    setVerdict(null);
    void run(async () => {
      await onSetRepo(next);
      setRepoDraft(undefined);
    }, "The repository could not be saved");
  };

  const saveToken = () => {
    const next = token.trim();
    if (!next) return;
    setToken("");
    setVerdict(null);
    void run(() => onSetToken(next), "The token could not be saved");
  };

  const check = async () => {
    setVerdict("checking");
    try {
      setVerdict(await verifyGithub());
    } catch {
      setVerdict({
        ok: false,
        reason: "unreachable",
        message: "The check itself failed. Try again in a moment.",
      });
    }
  };

  return (
    <div className="settings-section">
      {/*
        The steps are onboarding: needed once, in the way every visit after. They fold behind
        the question mark, which stays beside the sentence that says what the section is for.
      */}
      <div className="github-intro">
        <p className="chapters-note">
          Link a page to a pull request or branch, and the board follows the code: the page moves into Review
          while its pull request is open, and into Done when it merges.
        </p>
        <button
          aria-expanded={showingSetup}
          aria-label={showingSetup ? "Hide setup instructions" : "How do I set this up?"}
          className="github-help"
          onClick={() => setShowingSetup((showing) => !showing)}
          title="How do I set this up?"
          type="button"
        >
          ?
        </button>
      </div>

      <Growing className="github-setup-fold">
        {showingSetup && (
          <ol className="github-setup">
            <li>
              Name the repository this project&apos;s pull requests live in, as <code>owner/name</code>.
            </li>
            <li>
              For a private repository,{" "}
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                rel="noreferrer"
                target="_blank"
              >
                create a fine-grained access token
              </a>{" "}
              on GitHub: under <em>Only select repositories</em> choose this one, and under{" "}
              <em>Repository permissions</em> grant <em>Pull requests: read-only</em>. Nothing else is needed.
              A public repository needs no token at all.
            </li>
            <li>Paste the token below, then check the connection.</li>
            <li>
              On any page, the <strong>GitHub</strong> row in its details takes a pull request URL, a number
              like <code>#12</code>, or a branch name. A linked branch adopts whichever pull request it grows.
            </li>
            <li>Grimoire checks every couple of minutes, and only ever moves a page forward.</li>
          </ol>
        )}
      </Growing>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-github-repo">
          Repository
        </label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-github-repo"
            name="githubRepo"
            onBlur={saveRepo}
            onChange={(event) => setRepoDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveRepo();
              }
            }}
            placeholder="owner/repository"
            value={repo}
          />
        </div>
        <p className="settings-summary">
          Clearing it pauses the automation; nothing already linked is forgotten.
        </p>
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-github-token">
          Access token
        </label>
        <div className="settings-input">
          <input
            disabled={busy}
            id="settings-github-token"
            name="githubToken"
            onBlur={saveToken}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveToken();
              }
            }}
            placeholder={
              project.githubTokenSet ? "A token is saved. Paste a new one to replace it." : "github_pat_..."
            }
            type="password"
            value={token}
          />
        </div>
        <p className="settings-summary">It stays on the server and is never shown again.</p>
        {project.githubTokenSet && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void run(() => onSetToken(""), "The token could not be cleared")}
            type="button"
          >
            forget the saved token
          </button>
        )}
      </div>

      <div className="settings-row">
        <span className="field-label">Connection</span>
        <div className="github-check">
          <button
            className="quiet-button"
            disabled={busy || verdict === "checking"}
            onClick={() => void check()}
            type="button"
          >
            {verdict === "checking" ? "checking..." : "check the connection"}
          </button>
          {verdict !== null && verdict !== "checking" && (
            <p className={verdict.ok ? "github-check-result ok" : "github-check-result failed"} role="status">
              {verdict.ok
                ? `Connected: ${verdict.repo} (${verdict.private ? "private" : "public"} repository).`
                : verdict.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
