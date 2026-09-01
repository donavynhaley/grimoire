import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AuditPage,
  Chapter,
  DiscussionThread,
  Member,
  Page,
  ProjectCategory,
  ProjectField,
} from "../../shared/types";
import { useContentEditor } from "../hooks/use-content-editor";
import { usePageDiscussion } from "../hooks/use-page-discussion";
import { usePageHistory } from "../hooks/use-page-history";
import { ConfirmInline } from "./ConfirmInline";
import { DiscussionSection } from "./DiscussionSection";
import { Drawer } from "./Drawer";
import { GithubLink } from "./GithubLink";
import { NotesField } from "./NotesField";
import { PageHistory } from "./PageHistory";
import { PageRail } from "./PageRail";
import { otherEditorName, SaveState } from "./SaveState";

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
   * History starts folded. Editing a page refetches it, so an open list would redraw
   * itself under the notes on every save — motion next to the field someone is typing
   * in, for a section most visits never read.
   */
  const [showingHistory, setShowingHistory] = useState(false);
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
  // The rail's own folds get the same start by remounting under the page's key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: page.id is the trigger: opening a different page is what should put every fold back to where it starts on first sight
  useEffect(() => {
    setShowingHistory(false);
    setPane("notes");
    setAside("details");
    marked.current = null;
  }, [page.id]);

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
            viewLabel="View notes"
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
                  role="img"
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
            /* Keyed by the page so opening a different page starts every fold and picker in
               the rail where it would have started on first sight, not where the previous
               page left it. */
            <PageRail
              categories={categories}
              chapters={chapters}
              estimatesEnabled={estimatesEnabled}
              fields={fields}
              key={page.id}
              members={members}
              onUpdate={onUpdate}
              page={page}
              pages={pages}
            />
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
