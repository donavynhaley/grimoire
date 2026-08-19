import { useEffect, useRef, useState } from "react";
import type { Page } from "../../shared/types";
import { openPullRequests, type OpenPullRequest } from "../api/client";
import { Growing } from "./Growing";

type Props = {
  github: Page["github"];
  status: Page["githubStatus"];
  /** "owner/name", or empty when this project has not been pointed at a repository. */
  repo: string;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
};

/**
 * What a state is called, which depends on what was linked.
 *
 * "unchecked" covers two unrelated situations. A branch link has genuinely found no pull
 * request yet, which is a normal thing to sit at for days. A pull request link has simply
 * not been asked about yet, which lasts a moment - calling that "no PR yet" would tell
 * somebody who just picked a pull request from a list that it does not exist.
 */
function stateWord(state: string, kind: "pr" | "branch"): string {
  if (state !== "unchecked") {
    return { open: "open", draft: "draft", merged: "merged", closed: "closed", missing: "not found" }[state] ?? state;
  }
  return kind === "branch" ? "no PR yet" : "checking...";
}

/**
 * The page's tie to GitHub, chosen the way every other list in the product is chosen.
 *
 * It sits with the writing rather than in the properties rail, because which pull request a
 * page is about is closer to what the page says than to how it is filed - and because the
 * rail's narrow column cannot show a pull request title anybody could read.
 *
 * The panel lists what the repository actually has open, drafts included, and narrows by
 * number, title, or branch. Anything typed still stands on its own: a branch nobody has
 * opened a pull request for, or a URL in another repository, is offered as its own choice
 * at the foot of the list rather than being second-guessed.
 */
export function GithubLink({ github, status, repo, onUpdate }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pulls, setPulls] = useState<OpenPullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [refused, setRefused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  // Asked once per opening; the server holds the answer briefly for everyone else.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    openPullRequests()
      .then((answer) => { if (alive) setPulls(answer.pulls); })
      // A project with no repository, or one GitHub will not answer for, simply offers no
      // suggestions. The field still takes anything written into it.
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const typed = query.trim();
  const needle = typed.toLowerCase().replace(/^#/, "");
  const matches = needle
    ? pulls.filter((pull) =>
      String(pull.number).startsWith(needle) ||
      pull.title.toLowerCase().includes(needle) ||
      pull.branch.toLowerCase().includes(needle))
    : pulls;
  // Something typed that is not simply one of the offered numbers is a choice of its own.
  const offersTyped = typed !== "" && !matches.some((pull) => `#${pull.number}` === typed || String(pull.number) === typed);

  const choose = async (reference: string) => {
    setRefused(false);
    try {
      await onUpdate({ github: reference });
      setOpen(false);
      setQuery("");
    } catch {
      // The server owns the vocabulary; here it is enough to say it said no.
      setRefused(true);
    }
  };

  /*
   * A project that has never been pointed at a repository has no use for this at all, so it
   * is absent rather than present-and-useless. A link made before the repository was cleared
   * still shows, because something already linked must remain visible and removable.
   */
  if (!repo && !github) return null;

  const state = status?.state ?? "unchecked";
  const label = github === null
    ? "Not linked"
    : github.kind === "pr" || status?.prNumber
      ? `#${status?.prNumber ?? (github.kind === "pr" ? github.number : "?")}`
      : `⎇ ${github.name}`;

  return (
    <Growing className="dialog-section page-github">
      <span className="field-label">GitHub</span>
      <div className="github-picker" ref={rootRef}>
        <div className="github-current">
          <button
            aria-expanded={open}
            aria-haspopup="listbox"
            className={`github-trigger ${github ? `github-state-${state}` : ""}`}
            onClick={() => setOpen((showing) => !showing)}
            type="button"
          >
            <span className="github-trigger-label">{label}</span>
            {github && <span className="github-trigger-state">{stateWord(state, github.kind)}</span>}
            {status?.prTitle && <span className="github-trigger-title">{status.prTitle}</span>}
            <span aria-hidden="true" className="github-trigger-caret">▾</span>
          </button>
          {status?.prUrl && (
            <a className="github-open-link" href={status.prUrl} rel="noreferrer" target="_blank">open on GitHub ↗</a>
          )}
          {github && (
            <button aria-label="Unlink from GitHub" className="rail-change" onClick={() => void onUpdate({ github: null })} type="button">
              unlink
            </button>
          )}
        </div>

        {open && (
          <div aria-label="Link a pull request or branch" className="github-panel" role="listbox">
            <label className="github-search">
              <span className="sr-only">Search pull requests, or type a branch</span>
              <input
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (matches.length > 0) void choose(`#${matches[0].number}`);
                    else if (typed) void choose(typed);
                    return;
                  }
                  if (event.key !== "Escape") return;
                  // Closing the picker must not also close the page behind it.
                  event.stopPropagation();
                  setOpen(false);
                }}
                placeholder="Search pull requests, or paste a URL or branch..."
                type="search"
                value={query}
              />
            </label>

            <div className="github-options">
              {matches.map((pull) => (
                <button
                  aria-label={`Link pull request ${pull.number}, ${pull.title}`}
                  className="github-option"
                  key={pull.number}
                  onClick={() => void choose(`#${pull.number}`)}
                  role="option"
                  type="button"
                >
                  <span className="github-option-head">
                    <span className="github-option-number">#{pull.number}</span>
                    {pull.state === "draft" && <span className="github-draft-tag">draft</span>}
                  </span>
                  <strong className="github-option-title">{pull.title}</strong>
                  <small className="github-option-meta">⎇ {pull.branch}{pull.author ? ` · ${pull.author}` : ""}</small>
                </button>
              ))}

              {loading && matches.length === 0 && <p className="github-empty">Asking GitHub...</p>}
              {!loading && pulls.length === 0 && !typed && (
                <p className="github-empty">
                  No open pull requests to offer. Type a branch or paste a link, or set the
                  repository in project settings.
                </p>
              )}
              {!loading && pulls.length > 0 && matches.length === 0 && !typed && (
                <p className="github-empty">No open pull requests.</p>
              )}
            </div>

            {offersTyped && (
              <button className="github-use-typed" onClick={() => void choose(typed)} type="button">
                Use <strong>{typed}</strong> as written
              </button>
            )}
            {refused && (
              <p className="github-refused" role="alert">
                That does not read as a pull request, a branch, or a GitHub URL.
              </p>
            )}
          </div>
        )}
      </div>
    </Growing>
  );
}
