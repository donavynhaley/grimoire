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
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { EditorState, otherEditorName } from "./EditorState";
import { NotesField } from "./NotesField";
import { describeChange, describeEvent, relativeLabel } from "./activity-copy";
import { useContentEditor } from "./use-content-editor";
import { useDialogEscape } from "./use-dialog-escape";

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
  currentUserId: string;
  members: Member[];
  revision: number;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
  onLoadActivity: (options: { entityId?: string; limit?: number }) => Promise<AuditPage>;
};

export function PageDialog({ page, pages, categories, chapters, currentUserId, members, revision, onUpdate, onArchive, onClose, onLoadActivity }: Props) {
  const categoryColor = (slug: string | null) =>
    slug ? categories.find((category) => category.slug === slug)?.color : undefined;
  const swatchStyle = (slug: string | null) => {
    const color = categoryColor(slug);
    return color ? ({ "--category-color": color } as React.CSSProperties) : undefined;
  };
  const [confirmArchive, setConfirmArchive] = useState(false);
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

  useDialogEscape(close);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section aria-labelledby="dialog-panel-title" aria-modal="true" className="dialog-panel" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">page details</p><h2 id="dialog-panel-title">Edit page</h2></div>
          <button aria-label="Close page" className="icon-button" onClick={() => void close()} type="button">×</button>
        </header>

        <div className="record-form">
          <label><span>Title</span><input name="title" onChange={(event) => editor.setTitle(event.target.value)} value={editor.title} /></label>
          <NotesField
            editLabel="Edit notes"
            label="Notes"
            name="description"
            onChange={editor.setDescription}
            placeholder="Add only the context someone needs to act..."
            rows={6}
            textareaLabel="Notes"
            value={editor.description}
          />
          <EditorState editor={editor} who={otherEditor} />
        </div>

        <div className="dialog-section">
          <span className="field-label">Category</span>
          <div className="choice-grid category-choices">
            <button
              aria-label="Clear category"
              className={!page.category ? "choice active" : "choice"}
              onClick={() => onUpdate({ category: null })}
              type="button"
            >
              uncategorized
            </button>
            {categories.map((category) => (
              <button
                aria-label={`Categorize as ${category.name}`}
                className={page.category === category.slug ? "choice active" : "choice"}
                key={category.slug}
                onClick={() => onUpdate({ category: category.slug })}
                type="button"
              >
                <span className="category-swatch" style={{ "--category-color": category.color } as React.CSSProperties} />{category.name}
              </button>
            ))}
          </div>
        </div>

        {chapters.length > 0 && (
          <div className="dialog-section">
            <span className="field-label">Chapter</span>
            {/* Direct buttons, like every other page control, rather than a menu. */}
            <div className="choice-grid chapter-choices">
              <button
                aria-label="Remove from every chapter"
                className={!page.chapter ? "choice active" : "choice"}
                onClick={() => onUpdate({ chapter: null })}
                type="button"
              >
                no chapter
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

        <div className="dialog-section dependency-section">
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
        </div>

        <div className="dialog-section">
          <span className="field-label">Who is working on it?</span>
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

        <div className="dialog-section">
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

        <PageHistory events={history} members={members} />

        <footer className="dialog-footer">
          <span>created by {page.createdByName}</span>
          {confirmArchive ? (
            <div className="archive-confirm"><span>archive this page?</span><button className="danger-button" onClick={onArchive} type="button">yes, archive</button><button className="text-button" onClick={() => setConfirmArchive(false)} type="button">cancel</button></div>
          ) : <button className="text-button danger-text" onClick={() => setConfirmArchive(true)} type="button">archive page</button>}
        </footer>
      </section>
    </div>
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

function PageHistory({ events, members }: { events: AuditEvent[] | null; members: Member[] }) {
  const now = useMemo(() => new Date(), [events]);
  if (events === null) return null;
  return (
    <div className="dialog-section page-history">
      <span className="field-label">History</span>
      {events.length === 0 ? (
        <p className="empty-dependencies">No recorded changes yet.</p>
      ) : (
        <ol>
          {events.map((event) => {
            const { lead } = describeEvent(event);
            const actor = members.find((member) => member.id === event.actorId);
            return (
              <li key={event.id}>
                <Avatar avatarUrl={actor?.avatarUrl} className="avatar tiny" name={event.actorName} />
                <span>
                  <strong>{event.actorName}</strong> {lead}
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
      )}
    </div>
  );
}
