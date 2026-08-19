import { useEffect, useMemo, useRef, useState } from "react";
import {
  PAGE_STATUSES,
  type AuditEvent,
  type AuditPage,
  type Page,
  type PageStatus,
  type Chapter,
  type Member,
  type ProjectCategory,
  type ProjectField,
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { PageFieldsEditor } from "./PageFields";
import { EditorState, otherEditorName } from "./EditorState";
import { Growing } from "./Growing";
import { NotesField } from "./NotesField";
import { describeChange, describeEvent, relativeLabel } from "./activity-copy";
import { Drawer } from "./Drawer";
import { GithubLink } from "./GithubLink";
import { useContentEditor } from "./use-content-editor";

const PAGE_HISTORY_LIMIT = 6;

const labels: Record<PageStatus, string> = {
  backlog: "Backlog",
  ready: "Up Next",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

type Props = {
  page: Page;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  fields: ProjectField[];
  currentUserId: string;
  /** The project's repository, so a project without one shows no GitHub surface at all. */
  githubRepo: string;
  members: Member[];
  revision: number;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
  onLoadActivity: (options: { entityId?: string; limit?: number }) => Promise<AuditPage>;
};

export function PageDialog({ page, pages, categories, chapters, fields, currentUserId, githubRepo, members, revision, onUpdate, onArchive, onClose, onLoadActivity }: Props) {
  const categoryColor = (slug: string | null) =>
    slug ? categories.find((category) => category.slug === slug)?.color : undefined;
  const swatchStyle = (slug: string | null) => {
    const color = categoryColor(slug);
    return color ? ({ "--category-color": color } as React.CSSProperties) : undefined;
  };
  const [confirmArchive, setConfirmArchive] = useState(false);
  /**
   * Category is the only attribute long enough to be worth folding: ten choices against four
   * or five everywhere else, and it is usually set once at capture time with `#` and rarely
   * revisited. Column, assignee, and chapter stay one click, because those are the ones
   * someone opens a page to change.
   */
  const [changingCategory, setChangingCategory] = useState(false);
  /**
   * History starts folded. Editing a page refetches it, so an open list would redraw
   * itself under the notes on every save — motion next to the field someone is typing
   * in, for a section most visits never read.
   */
  const [showingHistory, setShowingHistory] = useState(false);
  const [findingBlocker, setFindingBlocker] = useState(false);
  const [blockerQuery, setBlockerQuery] = useState("");
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  const remote = useMemo(
    () => ({ title: page.title, description: page.description }),
    [page.title, page.description],
  );
  const editor = useContentEditor({
    remote,
    resetKey: page.id,
    save: (input) => updateRef.current(input),
  });

  useEffect(() => {
    setFindingBlocker(false);
    setBlockerQuery("");
    setChangingCategory(false);
    setShowingHistory(false);
  }, [page.id]);

  const blockers = page.blockedBy
    .map((id) => pages.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Page => Boolean(candidate));
  const normalizedBlockerQuery = blockerQuery.trim().toLowerCase();
  const blockerResults = normalizedBlockerQuery
    ? pages
      .filter((candidate) =>
        candidate.id !== page.id &&
        candidate.status !== "done" &&
        !page.blockedBy.includes(candidate.id) &&
        `${candidate.title}\n${candidate.category ?? "uncategorized"}`.toLowerCase().includes(normalizedBlockerQuery))
      .slice(0, 6)
    : [];

  const addBlocker = async (id: string) => {
    await onUpdate({ blockedBy: [...page.blockedBy, id] });
    setFindingBlocker(false);
    setBlockerQuery("");
  };

  const removeBlocker = (id: string) => onUpdate({
    blockedBy: page.blockedBy.filter((dependencyId) => dependencyId !== id),
  });

  const history = usePageHistory(page.id, revision, onLoadActivity);
  const otherEditor = otherEditorName(history, currentUserId);

  const close = async () => {
    if (await editor.flush()) onClose();
  };

  return (
    <Drawer className="dialog-panel page-editor" labelledBy="dialog-panel-title" onClose={close}>
      <header className="dialog-header">
        <div><p className="eyebrow">page details</p><h2 id="dialog-panel-title">Edit page</h2></div>
        <button aria-label="Close page" className="icon-button" onClick={() => void close()} type="button">×</button>
      </header>

      <div className="page-editor-split">
        <div className="page-editor-main">
          <div className="record-form">
            <label><span>Title</span><input name="title" onChange={(event) => editor.setTitle(event.target.value)} value={editor.title} /></label>
            <NotesField
              editLabel="Edit notes"
              label="Notes"
              name="description"
              onChange={editor.setDescription}
              placeholder="Add only the context someone needs to act..."
              rows={10}
              textareaLabel="Notes"
              value={editor.description}
            />
            <EditorState editor={editor} who={otherEditor} />
          </div>

          <GithubLink github={page.github} onUpdate={onUpdate} repo={githubRepo} status={page.githubStatus} />

          <PageHistory
            events={history}
            members={members}
            onToggle={() => setShowingHistory((showing) => !showing)}
            open={showingHistory}
          />

          <footer className="dialog-footer">
            <span>created by {page.createdByName}</span>
            {confirmArchive ? (
              <div className="archive-confirm"><span>archive this page?</span><button className="danger-button" onClick={onArchive} type="button">yes, archive</button><button className="text-button" onClick={() => setConfirmArchive(false)} type="button">cancel</button></div>
            ) : <button className="text-button danger-text" onClick={() => setConfirmArchive(true)} type="button">archive page</button>}
          </footer>
        </div>

        {/* Properties sit beside the writing rather than under it, ordered by how often
            someone reaches for them. */}
        <div aria-label="Page properties" className="page-rail">
          <div className="rail-row">
            <span className="field-label">Column</span>
            <div className="choice-grid status-choices">
              {PAGE_STATUSES.map((status) => (
                <button
                  aria-label={`Move to ${labels[status]}`}
                  className={page.status === status ? "choice active" : "choice"}
                  key={status}
                  onClick={() => onUpdate({ status, position: 99_999 })}
                  type="button"
                >
                  <span className={`column-dot ${status}`} />{labels[status]}
                </button>
              ))}
            </div>
          </div>

          <div className="rail-row">
            <span className="field-label">Who</span>
            <div className="choice-grid assignee-choices">
              <button className={!page.assigneeId ? "choice active" : "choice"} onClick={() => onUpdate({ assigneeId: null })} type="button">unassigned</button>
              {members.map((member) => (
                <button
                  aria-label={`Assign ${member.name}`}
                  className={page.assigneeId === member.id ? "choice active" : "choice"}
                  key={member.id}
                  onClick={() => onUpdate({ assigneeId: member.id })}
                  type="button"
                >
                  <Avatar avatarUrl={member.avatarUrl} className="avatar tiny" name={member.name} />{member.name}
                </button>
              ))}
            </div>
          </div>

          {chapters.length > 0 && (
            <div className="rail-row">
              <span className="field-label">Chapter</span>
              <div className="choice-grid chapter-choices">
                <button
                  aria-label="Remove from every chapter"
                  className={!page.chapter ? "choice active" : "choice"}
                  onClick={() => onUpdate({ chapter: null })}
                  type="button"
                >
                  none
                </button>
                {chapters.map((chapter) => (
                  <button
                    aria-label={`Place in ${chapter.name}`}
                    className={page.chapter === chapter.slug ? "choice active" : "choice"}
                    key={chapter.slug}
                    onClick={() => onUpdate({ chapter: chapter.slug })}
                    type="button"
                  >
                    {chapter.name}
                    {chapter.state === "open" && <span className="choice-note">open</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Growing className="rail-row">
            <span className="field-label">Category</span>
            {changingCategory ? (
              <div className="choice-grid category-choices">
                <button
                  aria-label="Clear category"
                  className={!page.category ? "choice active" : "choice"}
                  onClick={() => { void onUpdate({ category: null }); setChangingCategory(false); }}
                  type="button"
                >
                  none
                </button>
                {categories.map((category) => (
                  <button
                    aria-label={`Categorize as ${category.name}`}
                    className={page.category === category.slug ? "choice active" : "choice"}
                    key={category.slug}
                    onClick={() => { void onUpdate({ category: category.slug }); setChangingCategory(false); }}
                    type="button"
                  >
                    <span className="category-swatch" style={{ "--category-color": category.color } as React.CSSProperties} />{category.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rail-value">
                <span className="rail-current">
                  <span className={`category-swatch ${page.category ? "" : "category-none"}`} style={swatchStyle(page.category)} />
                  {page.category ? categories.find((category) => category.slug === page.category)?.name ?? page.category : "uncategorized"}
                </span>
                <button
                  aria-label="Change category"
                  className="rail-change"
                  onClick={() => setChangingCategory(true)}
                  type="button"
                >change</button>
              </div>
            )}
          </Growing>

          <PageFieldsEditor fields={fields} values={page.fields} onUpdate={onUpdate} />

          <Growing className="rail-row dependency-section">
            <span className="field-label">Blocked by</span>
            {blockers.length > 0 ? (
              <div className="dependency-list">
                {blockers.map((blocker) => (
                  <div className={blocker.status === "done" ? "dependency resolved" : "dependency"} key={blocker.id}>
                    <span className={`category-swatch ${blocker.category ? "" : "category-none"}`} style={swatchStyle(blocker.category)} />
                    <span><strong>{blocker.title}</strong><small>{blocker.status === "done" ? "resolved" : labels[blocker.status]}</small></span>
                    <button aria-label={`Remove blocker ${blocker.title}`} onClick={() => void removeBlocker(blocker.id)} type="button">×</button>
                  </div>
                ))}
              </div>
            ) : <p className="empty-dependencies">This page can move forward now.</p>}
            {findingBlocker ? (
              <div className="dependency-search">
                <label>
                  <span className="sr-only">Find a blocking page</span>
                  <input
                    aria-label="Find a blocking page"
                    autoFocus
                    onChange={(event) => setBlockerQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      // Leaving the search must not also close the whole page.
                      event.stopPropagation();
                      setFindingBlocker(false);
                    }}
                    placeholder="Type a page title..."
                    type="search"
                    value={blockerQuery}
                  />
                </label>
                {normalizedBlockerQuery && (
                  <div className="dependency-results">
                    {blockerResults.map((candidate) => (
                      <button
                        aria-label={`Blocked by ${candidate.title}`}
                        key={candidate.id}
                        onClick={() => void addBlocker(candidate.id)}
                        type="button"
                      >
                        <span className={`category-swatch ${candidate.category ? "" : "category-none"}`} style={swatchStyle(candidate.category)} />
                        <span><strong>{candidate.title}</strong><small>{candidate.category ? categories.find((category) => category.slug === candidate.category)?.name ?? candidate.category : "uncategorized"}</small></span>
                      </button>
                    ))}
                    {blockerResults.length === 0 && <p>No matching open pages.</p>}
                  </div>
                )}
                <button className="text-button" onClick={() => { setFindingBlocker(false); setBlockerQuery(""); }} type="button">cancel</button>
              </div>
            ) : (
              <button aria-label="Add blocking page" className="add-dependency" onClick={() => setFindingBlocker(true)} type="button">+ add blocking page</button>
            )}
          </Growing>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * Loads the recent history for one page.
 *
 * Results are kept alongside the page they belong to, so a refetch triggered by an
 * autosave leaves the list in place instead of collapsing the section on every
 * keystroke pause, while switching pages still hides the previous page's history.
 *
 * A failed lookup stays silent: the history is context, and an error banner over it
 * would sit above editing controls that still work perfectly well.
 *
 * The load runs even while the section is folded, because the same events name whoever
 * else touched this page in the conflict bar.
 */
function usePageHistory(
  pageId: string,
  revision: number,
  load: (options: { entityId?: string; limit?: number }) => Promise<AuditPage>,
): AuditEvent[] | null {
  const [loaded, setLoaded] = useState<{ pageId: string; events: AuditEvent[] } | null>(null);

  useEffect(() => {
    let alive = true;
    load({ entityId: pageId, limit: PAGE_HISTORY_LIMIT })
      .then((page) => { if (alive) setLoaded({ pageId, events: page.events }); })
      .catch(() => { if (alive) setLoaded({ pageId, events: [] }); });
    return () => { alive = false; };
  }, [pageId, load, revision]);

  return loaded?.pageId === pageId ? loaded.events : null;
}

/**
 * The header is always present so the section never appears or resizes on its own;
 * only what someone asked to see is drawn.
 */
function PageHistory({ events, members, onToggle, open }: {
  events: AuditEvent[] | null;
  members: Member[];
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <Growing className="dialog-section page-history">
      <button aria-expanded={open} className="history-toggle" onClick={onToggle} type="button">
        <span aria-hidden="true" className="history-caret">{open ? "▾" : "▸"}</span>
        <span className="field-label">History</span>
      </button>
      {open && <HistoryEvents events={events} members={members} />}
    </Growing>
  );
}

function HistoryEvents({ events, members }: { events: AuditEvent[] | null; members: Member[] }) {
  const now = useMemo(() => new Date(), [events]);
  if (events === null) return <p className="empty-dependencies">Reading the record...</p>;
  if (events.length === 0) return <p className="empty-dependencies">No recorded changes yet.</p>;
  return (
    <ol>
      {events.map((event) => {
        const { lead } = describeEvent(event);
        const actor = members.find((member) => member.id === event.actorId);
        return (
          <li key={event.id}>
            <Avatar avatarUrl={actor?.avatarUrl} className="avatar tiny" name={event.actorName} />
            <span>
              <strong>{event.actorName}</strong>
              {event.agentName && <span className="via-agent"> via {event.agentName}</span>} {lead}
              {event.changes.length > 0 && (
                <span className="activity-changes">
                  {event.changes.map((change) => <span key={change.field}>{describeChange(change)}</span>)}
                </span>
              )}
            </span>
            <time dateTime={event.createdAt}>{relativeLabel(event.createdAt, now)}</time>
          </li>
        );
      })}
    </ol>
  );
}

