import { useEffect, useMemo, useRef, useState } from "react";
import {
  PAGE_STATUSES,
  type AuditEvent,
  type AuditPage,
  type Page,
  type PageStatus,
  type Chapter,
  type DiscussionThread,
  type Member,
  type ProjectCategory,
  type ProjectField,
  PAGE_STATUS_LABELS,
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { ConfirmInline } from "./ConfirmInline";
import { PageFieldsEditor } from "./PageFields";
import { otherEditorName, SaveState } from "./SaveState";
import { Growing } from "./Growing";
import { NotesField } from "./NotesField";
import { describeChange, describeEvent, relativeLabel } from "./activity-copy";
import { categoryColorStyle, categoryStyle } from "./category-style";
import { DiscussionSection } from "./DiscussionSection";
import { Drawer } from "./Drawer";
import { GithubLink } from "./GithubLink";
import { useContentEditor } from "./use-content-editor";

const PAGE_HISTORY_LIMIT = 6;

const labels = PAGE_STATUS_LABELS;

type Props = {
  page: Page;
  pages: Page[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  fields: ProjectField[];
  currentUserId: string;
  /** The project's repository, so a project without one shows no GitHub surface at all. */
  githubRepo: string;
  /** Off unless the project asked for estimates, and then no page shows one. */
  estimatesEnabled: boolean;
  members: Member[];
  revision: number;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
  onLoadActivity: (options: { entityId?: string; limit?: number }) => Promise<AuditPage>;
  /** The conversation on this page, and the three things anyone can do to it. */
  onLoadDiscussion: (pageId: string) => Promise<{ threads: DiscussionThread[] }>;
  onAsk: (pageId: string, body: string) => Promise<void>;
  onReply: (pageId: string, threadId: string, body: string) => Promise<void>;
  onSetAnswered: (pageId: string, threadId: string, answered: boolean) => Promise<void>;
  /** Called the moment the conversation is actually looked at, and only then. */
  onSeeDiscussion: (pageId: string) => Promise<void>;
};

export function PageDialog({
  page,
  pages,
  categories,
  chapters,
  estimatesEnabled,
  fields,
  currentUserId,
  githubRepo,
  members,
  revision,
  onUpdate,
  onArchive,
  onClose,
  onLoadActivity,
  onLoadDiscussion,
  onAsk,
  onReply,
  onSetAnswered,
  onSeeDiscussion,
}: Props) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  /**
   * Which half of the page is on screen when there is only room for one.
   *
   * At a desk both halves stand side by side and this is never read: the stylesheet shows
   * the switch, and honours the choice, only below the width the split needs. Narrower
   * than that the alternative was one long scroll, and a page that has to be scrolled is
   * a page you cannot see.
   */
  const [pane, setPane] = useState<"notes" | "aside">("notes");
  /**
   * What the second column is showing.
   *
   * The properties and the conversation take turns in it rather than standing side by side,
   * because nobody reads an estimate and a question at the same time, and giving them one
   * column between them is what keeps the writing column exactly the width it always was.
   *
   * It starts on the properties. A page opens on what it is, not on what was said about it.
   */
  const [aside, setAside] = useState<"details" | "discussion">("details");
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
  /*
   * Finished chapters fold away here for the same reason they do in the board's picker: they
   * accumulate for the life of the project, and a project a year in offers a page fifteen
   * buttons of which one is live. The fold opens on sight when this page belongs to a closed
   * chapter, because otherwise the row would show no selection and the reason would be hidden.
   */
  const inClosedChapter = chapters.some(
    (chapter) => chapter.state === "closed" && chapter.slug === page.chapter,
  );
  const [showingClosedChapters, setShowingClosedChapters] = useState(inClosedChapter);
  const liveChapters = chapters.filter((chapter) => chapter.state !== "closed");
  const closedChapters = chapters.filter((chapter) => chapter.state === "closed");
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

  // Opening a different page starts every fold where it would have started on first sight,
  // so reaching into the earlier chapters for one page is not a choice the next page inherits.
  useEffect(() => {
    setFindingBlocker(false);
    setBlockerQuery("");
    setChangingCategory(false);
    setShowingHistory(false);
    setPane("notes");
    setAside("details");
    marked.current = null;
    setShowingClosedChapters(inClosedChapter);
    // `inClosedChapter` is read for the page being opened, not tracked: a page moved into a
    // closed chapter from the open fold must not re-run this and fold it away underneath.
  }, [page.id]);

  const blockers = page.blockedBy
    .map((id) => pages.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Page => Boolean(candidate));
  const normalizedBlockerQuery = blockerQuery.trim().toLowerCase();
  const blockerResults = normalizedBlockerQuery
    ? pages
        .filter(
          (candidate) =>
            candidate.id !== page.id &&
            candidate.status !== "done" &&
            !page.blockedBy.includes(candidate.id) &&
            `${candidate.title}\n${candidate.category ?? "uncategorized"}`
              .toLowerCase()
              .includes(normalizedBlockerQuery),
        )
        .slice(0, 6)
    : [];

  const addBlocker = async (id: string) => {
    await onUpdate({ blockedBy: [...page.blockedBy, id] });
    setFindingBlocker(false);
    setBlockerQuery("");
  };

  const removeBlocker = (id: string) =>
    onUpdate({
      blockedBy: page.blockedBy.filter((dependencyId) => dependencyId !== id),
    });

  const history = usePageHistory(page.id, revision, onLoadActivity);
  const {
    threads,
    failed: discussionFailed,
    reload: reloadDiscussion,
  } = usePageDiscussion(page.id, revision, onLoadDiscussion);
  /*
   * What the control counts is what has not been read, not what is unresolved.
   *
   * An open thread you have already read is not news; a reply to a question you asked is,
   * even though it closed nothing. The number is there to say "there is something here for
   * you", and unread is the only count that answers that. It comes from the page rather than
   * the loaded threads so it is there before the conversation has finished arriving.
   */
  const unseenCount = page.unseenMessages;
  const namedCount = page.unseenMentions;
  const showingDiscussion = aside === "discussion";

  /*
   * Turning to the conversation is what counts as having read it.
   *
   * Once per page: a second mark would follow its own board refresh round and round. Anything
   * posted while it is on screen is unread again on the next visit, which is a count that
   * flickers rather than one that lies.
   */
  const marked = useRef<string | null>(null);
  useEffect(() => {
    // Not until it has actually arrived. Marking a conversation read because somebody asked
    // to see one, when what they were shown was a spinner or a failure, loses the only signal
    // saying there was something here.
    if (!showingDiscussion || threads === null || marked.current === page.id) return;
    marked.current = page.id;
    void onSeeDiscussion(page.id);
  }, [showingDiscussion, threads, page.id, onSeeDiscussion]);
  const otherEditor = otherEditorName(history, currentUserId);

  const close = async () => {
    if (await editor.flush()) onClose();
  };

  return (
    <Drawer className="dialog-panel page-editor" labelledBy="dialog-panel-title" onClose={close}>
      <header className="dialog-header">
        <div>
          <p className="eyebrow">page details</p>
          <h2 id="dialog-panel-title">Edit page</h2>
        </div>
        <button aria-label="Close page" className="icon-button" onClick={() => void close()} type="button">
          ×
        </button>
      </header>

      {/*
        The switch between the two halves. It is hidden by the stylesheet wherever they fit
        side by side, so the control exists only where there is a choice to make - and the
        breakpoint stays written once, in the sheet, rather than copied into a media query
        listener here.
      */}
      <div aria-label="Page halves" className="page-editor-panes" role="group">
        <button
          aria-pressed={pane === "notes"}
          className="pane-tab"
          onClick={() => setPane("notes")}
          type="button"
        >
          Notes
        </button>
        <button
          aria-pressed={pane === "aside" && aside === "details"}
          className="pane-tab"
          onClick={() => {
            setPane("aside");
            setAside("details");
          }}
          type="button"
        >
          Details
        </button>
        <button
          aria-pressed={pane === "aside" && aside === "discussion"}
          className="pane-tab"
          onClick={() => {
            setPane("aside");
            setAside("discussion");
          }}
          type="button"
        >
          Discussion{unseenCount > 0 ? ` · ${unseenCount}` : ""}
          {namedCount > 0 ? " @" : ""}
        </button>
      </div>

      <div className="page-editor-split" data-pane={pane}>
        <div className="page-editor-main">
          <div className="record-form">
            <label>
              <span>Title</span>
              <input
                name="title"
                onChange={(event) => editor.setTitle(event.target.value)}
                value={editor.title}
              />
            </label>
          </div>

          {/* The notes take whatever height the column has left over, and are the only
              thing on this panel allowed to scroll. */}
          <NotesField
            editLabel="Edit notes"
            editorLabel="Notes"
            fill
            label="Notes"
            onChange={editor.setDescription}
            placeholder="Add only the context someone needs to act..."
            rows={10}
            value={editor.description}
          />

          <GithubLink github={page.github} onUpdate={onUpdate} repo={githubRepo} status={page.githubStatus} />
        </div>

        {/*
          One column, two things taking turns in it.

          The properties and the conversation are never read at the same time - nobody weighs
          an estimate and answers a question in one breath - so they share a column rather
          than each taking one. That is what keeps the writing column exactly the width it has
          always been: nothing here resizes, so there is no layout change to travel.
        */}
        <div className="page-aside">
          <div aria-label="What this column shows" className="aside-switch" role="group">
            <button
              aria-pressed={aside === "details"}
              className="pane-tab"
              onClick={() => setAside("details")}
              type="button"
            >
              Details
            </button>
            <button
              aria-pressed={aside === "discussion"}
              className="pane-tab"
              onClick={() => setAside("discussion")}
              type="button"
            >
              Discussion
              {/*
                One badge, two states. Something new here is worth a quiet number; somebody
                writing your name is worth the accent, because they meant you specifically.
              */}
              {unseenCount > 0 && (
                <span
                  aria-label={
                    namedCount > 0
                      ? `${unseenCount} unread, ${namedCount} naming you`
                      : `${unseenCount} unread`
                  }
                  className={namedCount > 0 ? "discussion-unseen named" : "discussion-unseen"}
                >
                  {unseenCount}
                </span>
              )}
            </button>
          </div>

          {aside === "discussion" ? (
            <DiscussionSection
              currentUserId={currentUserId}
              failed={discussionFailed}
              members={members}
              onAsk={async (body) => {
                await onAsk(page.id, body);
                await reloadDiscussion();
              }}
              onReply={async (threadId, body) => {
                await onReply(page.id, threadId, body);
                await reloadDiscussion();
              }}
              onSetAnswered={async (threadId, answered) => {
                await onSetAnswered(page.id, threadId, answered);
                await reloadDiscussion();
              }}
              threads={threads}
            />
          ) : (
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
                      <span className={`column-dot ${status}`} />
                      {labels[status]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rail-row">
                <span className="field-label">Who</span>
                <div className="choice-grid assignee-choices">
                  <button
                    className={!page.assigneeId ? "choice active" : "choice"}
                    onClick={() => onUpdate({ assigneeId: null })}
                    type="button"
                  >
                    unassigned
                  </button>
                  {members.map((member) => (
                    <button
                      aria-label={`Assign ${member.name}`}
                      className={page.assigneeId === member.id ? "choice active" : "choice"}
                      key={member.id}
                      onClick={() => onUpdate({ assigneeId: member.id })}
                      type="button"
                    >
                      <Avatar avatarUrl={member.avatarUrl} className="avatar tiny" name={member.name} />
                      {member.name}
                    </button>
                  ))}
                </div>
              </div>

              {chapters.length > 0 && (
                <Growing className="rail-row">
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
                    {liveChapters.map((chapter) => (
                      <ChapterChoice chapter={chapter} key={chapter.slug} onUpdate={onUpdate} page={page} />
                    ))}
                  </div>
                  {closedChapters.length > 0 && (
                    <>
                      <button
                        aria-expanded={showingClosedChapters}
                        className="chapter-group-label as-toggle in-rail"
                        onClick={() => setShowingClosedChapters((showing) => !showing)}
                        type="button"
                      >
                        <span>earlier</span>
                        <span className="chapter-group-count">{closedChapters.length}</span>
                        <span aria-hidden="true" className="chapter-group-caret">
                          {showingClosedChapters ? "▾" : "▸"}
                        </span>
                      </button>
                      {showingClosedChapters && (
                        <div className="choice-grid chapter-choices">
                          {closedChapters.map((chapter) => (
                            <ChapterChoice
                              chapter={chapter}
                              key={chapter.slug}
                              onUpdate={onUpdate}
                              page={page}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </Growing>
              )}

              <Growing className="rail-row">
                <span className="field-label">Category</span>
                {changingCategory ? (
                  <div className="choice-grid category-choices">
                    <button
                      aria-label="Clear category"
                      className={!page.category ? "choice active" : "choice"}
                      onClick={() => {
                        void onUpdate({ category: null });
                        setChangingCategory(false);
                      }}
                      type="button"
                    >
                      none
                    </button>
                    {categories.map((category) => (
                      <button
                        aria-label={`Categorize as ${category.name}`}
                        className={page.category === category.slug ? "choice active" : "choice"}
                        key={category.slug}
                        onClick={() => {
                          void onUpdate({ category: category.slug });
                          setChangingCategory(false);
                        }}
                        type="button"
                      >
                        <span className="category-swatch" style={categoryColorStyle(category.color)} />
                        {category.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rail-value">
                    <span className="rail-current">
                      <span
                        className={`category-swatch ${page.category ? "" : "category-none"}`}
                        style={categoryStyle(categories, page.category)}
                      />
                      {page.category
                        ? (categories.find((category) => category.slug === page.category)?.name ??
                          page.category)
                        : "uncategorized"}
                    </span>
                    <button
                      aria-label="Change category"
                      className="rail-change"
                      onClick={() => setChangingCategory(true)}
                      type="button"
                    >
                      change
                    </button>
                  </div>
                )}
              </Growing>

              {estimatesEnabled && (
                <Growing className="rail-row">
                  <span className="field-label">Estimate</span>
                  <EstimateRow estimate={page.estimate} onUpdate={onUpdate} />
                </Growing>
              )}

              <PageFieldsEditor fields={fields} values={page.fields} onUpdate={onUpdate} />

              <Growing className="rail-row dependency-section">
                <span className="field-label">Blocked by</span>
                {blockers.length > 0 ? (
                  <div className="dependency-list">
                    {blockers.map((blocker) => (
                      <div
                        className={blocker.status === "done" ? "dependency resolved" : "dependency"}
                        key={blocker.id}
                      >
                        <span
                          className={`category-swatch ${blocker.category ? "" : "category-none"}`}
                          style={categoryStyle(categories, blocker.category)}
                        />
                        <span>
                          <strong>{blocker.title}</strong>
                          <small>{blocker.status === "done" ? "resolved" : labels[blocker.status]}</small>
                        </span>
                        <button
                          aria-label={`Remove blocker ${blocker.title}`}
                          onClick={() => void removeBlocker(blocker.id)}
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-dependencies">This page can move forward now.</p>
                )}
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
                            <span
                              className={`category-swatch ${candidate.category ? "" : "category-none"}`}
                              style={categoryStyle(categories, candidate.category)}
                            />
                            <span>
                              <strong>{candidate.title}</strong>
                              <small>
                                {candidate.category
                                  ? (categories.find((category) => category.slug === candidate.category)
                                      ?.name ?? candidate.category)
                                  : "uncategorized"}
                              </small>
                            </span>
                          </button>
                        ))}
                        {blockerResults.length === 0 && <p>No matching open pages.</p>}
                      </div>
                    )}
                    <button
                      className="text-button"
                      onClick={() => {
                        setFindingBlocker(false);
                        setBlockerQuery("");
                      }}
                      type="button"
                    >
                      cancel
                    </button>
                  </div>
                ) : (
                  <button
                    aria-label="Add blocking page"
                    className="add-dependency"
                    onClick={() => setFindingBlocker(true)}
                    type="button"
                  >
                    + add blocking page
                  </button>
                )}
              </Growing>
            </div>
          )}
        </div>
      </div>

      {/*
        The record of the page stands under both halves, for the same reason the autosave line
        and the archive do: it is the page's history, not the notes' - and inside the writing
        column it was one more fixed thing the notes had to make room for.
      */}
      <PageHistory
        events={history}
        members={members}
        onToggle={() => setShowingHistory((showing) => !showing)}
        open={showingHistory}
      />

      {/* The autosave line and the archive stand under both halves rather than inside the
          writing, so a refused save is still in sight from the details. */}
      <SaveState editor={editor} who={otherEditor} />

      <footer className="dialog-footer">
        <span>created by {page.createdByName}</span>
        <ConfirmInline
          cancelClass="text-button"
          cancelLabel="cancel"
          className="archive-confirm"
          confirmClass="danger-button"
          confirmLabel="yes, archive"
          onCancel={() => setConfirmArchive(false)}
          onConfirm={onArchive}
          onOpen={() => setConfirmArchive(true)}
          open={confirmArchive}
          question="archive this page?"
          trigger="archive page"
          triggerClass="text-button danger-text"
        />
      </footer>
    </Drawer>
  );
}

/**
 * One chapter this page could be placed in.
 *
 * Shared by the live chapters and the folded ones so a chapter reads and behaves identically
 * either side of the fold: what is hidden is a group, never a different kind of control.
 */
function ChapterChoice({
  chapter,
  onUpdate,
  page,
}: {
  chapter: Chapter;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  page: Page;
}) {
  return (
    <button
      aria-label={`Place in ${chapter.name}`}
      className={page.chapter === chapter.slug ? "choice active" : "choice"}
      onClick={() => onUpdate({ chapter: chapter.slug })}
      type="button"
    >
      {chapter.name}
      {chapter.state === "open" && <span className="choice-note">open</span>}
    </button>
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
      .then((page) => {
        if (alive) setLoaded({ pageId, events: page.events });
      })
      .catch(() => {
        if (alive) setLoaded({ pageId, events: [] });
      });
    return () => {
      alive = false;
    };
  }, [pageId, load, revision]);

  return loaded?.pageId === pageId ? loaded.events : null;
}

/**
 * Loads the conversation on one page.
 *
 * Kept beside the page it belongs to for the same reason the history is: a refetch triggered
 * by an autosave should leave the threads in place rather than blanking them mid-read, while
 * switching pages must never show the previous page's conversation for a frame.
 *
 * `reload` is what a post calls once the write has landed, so the list reflects the server's
 * answer rather than a guess assembled on the client.
 */
function usePageDiscussion(
  pageId: string,
  revision: number,
  load: (pageId: string) => Promise<{ threads: DiscussionThread[] }>,
): { threads: DiscussionThread[] | null; failed: boolean; reload: () => Promise<void> } {
  const [loaded, setLoaded] = useState<{ pageId: string; threads: DiscussionThread[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    load(pageId)
      .then((result) => {
        if (alive) {
          setLoaded({ pageId, threads: result.threads });
          setFailed(null);
        }
      })
      /*
       * A conversation that could not be fetched is not an empty one.
       *
       * Drawing nothing beside a badge saying three things are unread says the messages are
       * gone, and marking them read on the strength of that would lose them for good.
       */
      .catch(() => {
        if (alive) setFailed(pageId);
      });
    return () => {
      alive = false;
    };
  }, [pageId, load, revision, reloads]);

  return {
    threads: loaded?.pageId === pageId ? loaded.threads : null,
    failed: failed === pageId,
    reload: async () => {
      setReloads((count) => count + 1);
    },
  };
}

/**
 * The header is always present so the section never appears or resizes on its own;
 * only what someone asked to see is drawn.
 */
function PageHistory({
  events,
  members,
  onToggle,
  open,
}: {
  events: AuditEvent[] | null;
  members: Member[];
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <Growing className="dialog-section page-history">
      <button aria-expanded={open} className="history-toggle" onClick={onToggle} type="button">
        <span aria-hidden="true" className="history-caret">
          {open ? "▾" : "▸"}
        </span>
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
                  {event.changes.map((change) => (
                    <span key={change.field}>{describeChange(change)}</span>
                  ))}
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

/**
 * How much work a page is, said as a number and nothing more.
 *
 * It rests as its value and edits as a plain input, like the written fields beside it, and an
 * emptied box clears it rather than storing a nought - "nobody has said" and "no work at all"
 * are different answers and the board counts them differently.
 */
function EstimateRow({
  estimate,
  onUpdate,
}: {
  estimate: number | null;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed) {
      if (estimate !== null) void onUpdate({ estimate: null });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed === estimate) return;
    void onUpdate({ estimate: parsed });
  };

  if (editing) {
    return (
      <input
        aria-label="Estimate"
        autoFocus
        inputMode="decimal"
        name="estimate"
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            setEditing(false);
          }
        }}
        type="text"
        value={draft}
      />
    );
  }

  return (
    <div className="rail-value">
      <span className="rail-current">{estimate === null ? "—" : estimate}</span>
      <button
        aria-label="Change estimate"
        className="rail-change"
        onClick={() => {
          setDraft(estimate === null ? "" : String(estimate));
          setEditing(true);
        }}
        type="button"
      >
        change
      </button>
    </div>
  );
}
