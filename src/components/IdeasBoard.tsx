import { type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Idea, IdeaState, IdeaWorkspace } from "../../shared/types";
import { type CardHint, useCardBoard } from "../hooks/use-card-board";
import { useContentEditor } from "../hooks/use-content-editor";
import { useFlip } from "../hooks/use-flip";
import { type DragPoint, gapIndexIn, pointWithin } from "../hooks/use-pointer-drag";
import { useTypingFocus } from "../hooks/use-typing-focus";
import { plainTextFromMarkdown } from "../lib/markdown-text";
import { ConfirmInline } from "./ConfirmInline";
import { Drawer } from "./Drawer";
import { LiftedGhost } from "./LiftedGhost";
import { MoveSlot } from "./MoveSlot";
import { MovingBar } from "./MovingBar";
import { NotesField } from "./NotesField";
import { SaveState } from "./SaveState";

/** Shortlist first, so a point inside it is read as a rank rather than as the layout behind it. */
const IDEA_STATES = ["shortlist", "inbox", "parked"] as const satisfies readonly IdeaState[];

const stateNames: Record<IdeaState, string> = {
  shortlist: "Shortlist",
  inbox: "Idea inbox",
  parked: "Parked",
};

type Props = {
  workspace: IdeaWorkspace;
  busy: boolean;
  /** An idea chosen elsewhere - in search - that the garden should open on arrival. */
  openIdea?: { id: string; token: number } | null;
  /** Ideas changed while the reader was away; opening one answers its dot. */
  unseenIdeaIds?: ReadonlySet<string>;
  onCreate: (input: { title: string }) => Promise<void>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<void>;
  onPromote: (id: string) => Promise<void>;
};

export function IdeasBoard({
  workspace,
  busy,
  openIdea,
  unseenIdeaIds,
  onCreate,
  onUpdate,
  onPromote,
}: Props) {
  const focusForTyping = useTypingFocus<HTMLInputElement>();
  const [title, setTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("idea"),
  );
  const sectionNodes = useRef(new Map<IdeaState, HTMLElement>());
  const layoutRef = useRef<HTMLDivElement>(null);
  useFlip(layoutRef);
  const shortlist = ideasIn(workspace, "shortlist");
  const inbox = ideasIn(workspace, "inbox");
  const parked = ideasIn(workspace, "parked");
  const selected = workspace.ideas.find((idea) => idea.id === selectedId) ?? null;

  // The open idea lives in the URL, mirroring how pages become shareable links; the write
  // happens here, in the handler that changes the selection, never in a sync effect.
  const changeSelected = (id: string | null) => {
    setSelectedId(id);
    const params = new URLSearchParams(location.search);
    if (id && workspace.ideas.some((idea) => idea.id === id)) params.set("idea", id);
    else params.delete("idea");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  // A shared link is reconciled once on arrival: an idea this garden no longer has simply
  // falls away. Every later write goes through changeSelected, and this must run before
  // the search-arrival effect below so it cannot undo that effect's write.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (selected) params.set("idea", selected.id);
    else params.delete("idea");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    // Runs only for the URL the garden arrived with; the state it reads is the mount seed.
  }, []);

  // Arriving from search opens the idea, even if the garden was already on screen.
  useEffect(() => {
    if (openIdea) changeSelected(openIdea.id);
  }, [openIdea?.token]);

  const capture = async (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    setTitle("");
    await onCreate({ title: value });
  };

  /**
   * Which section a point is over, and for the shortlist which gap within it.
   *
   * Only the shortlist is ordered by hand, so it is the only one that has to answer with a
   * position; the inbox and the parked list simply take what they are given.
   */
  const hintAt = (point: DragPoint): CardHint<IdeaState> | null => {
    for (const state of IDEA_STATES) {
      const node = sectionNodes.current.get(state);
      if (!node || !pointWithin(node.getBoundingClientRect(), point)) continue;
      if (state !== "shortlist") return { slot: state, index: 0 };
      return { slot: state, index: gapIndexIn(node, "article.shortlist-card:not(.drag-hidden)", point.y) };
    }
    return null;
  };

  const placeIdea = async (id: string, state: IdeaState, index: number) => {
    const idea = workspace.ideas.find((candidate) => candidate.id === id);
    if (!idea) return;
    if (state !== "shortlist") {
      if (idea.state !== state) await onUpdate(id, { state });
      return;
    }
    const base = shortlist.filter((candidate) => candidate.id !== id);
    const position = Math.min(index, base.length);
    if (idea.state === "shortlist" && shortlist.findIndex((candidate) => candidate.id === id) === position)
      return;
    await onUpdate(id, { state: "shortlist", position });
  };

  const {
    drag,
    dropHint,
    moving,
    movingItem: movingIdea,
    liftedId,
    liftedItem: liftedIdea,
    openedUnseen,
    pointerDrag,
    placeMoving,
    toggleMoving,
    cancelMoving,
  } = useCardBoard<IdeaState, Idea>({
    items: workspace.ideas,
    selectedId,
    hintAt,
    liftHint: (idea) =>
      idea.state === "shortlist"
        ? {
            slot: "shortlist",
            index: Math.max(
              0,
              shortlist.findIndex((candidate) => candidate.id === idea.id),
            ),
          }
        : null,
    place: (id, hint) => placeIdea(id, hint.slot, hint.index),
  });

  const isUnseen = (id: string) => Boolean(unseenIdeaIds?.has(id)) && !openedUnseen.has(id);
  const baseShortlist = liftedId ? shortlist.filter((idea) => idea.id !== liftedId) : shortlist;
  const hintIndex =
    drag && dropHint?.slot === "shortlist" ? Math.min(dropHint.index, baseShortlist.length) : null;
  const placeholder = drag ? (
    <div
      aria-hidden="true"
      className="drop-placeholder"
      data-flip-id="drop-placeholder"
      style={{ height: drag.height }}
    />
  ) : null;

  return (
    <main className="ideas-main">
      {movingIdea && <MovingBar onCancel={cancelMoving} title={movingIdea.title} />}
      <div className="ideas-intro">
        <div>
          <h2>Idea garden</h2>
          <p>
            Keep the strongest possibilities close, and turn one into work only when the team means to build
            it.
          </p>
        </div>
        <form className="idea-capture workspace-capture" onSubmit={capture}>
          <label className="sr-only" htmlFor="capture-idea">
            Capture an idea
          </label>
          <input
            id="capture-idea"
            ref={focusForTyping}
            name="ideaTitle"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Something worth remembering..."
            value={title}
          />
          <button className="primary-button" disabled={busy || !title.trim()} type="submit">
            capture
          </button>
        </form>
      </div>

      <div className="idea-layout" ref={layoutRef}>
        <section
          aria-label="Shortlist"
          className={`idea-section shortlist-section ${moving ? "moving-open" : ""}`}
          ref={(node) => {
            if (node) sectionNodes.current.set("shortlist", node);
            else sectionNodes.current.delete("shortlist");
          }}
        >
          <header className="idea-section-header">
            <div>
              <span className="idea-glyph">✦</span>
              <div>
                <p className="eyebrow">ranked by hand</p>
                <h3>Shortlist</h3>
              </div>
            </div>
            <span>{shortlist.length}</span>
          </header>
          <div className="shortlist-list">
            {movingIdea && (
              <MoveSlot
                index={0}
                onPlace={placeMoving}
                slot="shortlist"
                slotName={stateNames.shortlist}
                title={movingIdea.title}
              />
            )}
            {shortlist.map((idea) => {
              const hidden = liftedId === idea.id;
              const slot = hidden ? -1 : baseShortlist.findIndex((candidate) => candidate.id === idea.id);
              const rank = hintIndex !== null && slot >= hintIndex ? slot + 1 : slot;
              return (
                <Fragment key={idea.id}>
                  {!hidden && slot === hintIndex && placeholder}
                  <article
                    className={`idea-card shortlist-card ${hidden ? "drag-hidden" : ""} ${isUnseen(idea.id) ? "unseen" : ""}`}
                    data-flip-id={idea.id}
                    onPointerDown={(event) => pointerDrag.start(event, idea.id)}
                  >
                    <span className="rank-number">{String(rank + 1).padStart(2, "0")}</span>
                    <IdeaOpenButton
                      guardClick={pointerDrag.consumeClick}
                      idea={idea}
                      onOpen={() => changeSelected(idea.id)}
                      unseen={isUnseen(idea.id)}
                    />
                    <div className="idea-actions">
                      <button
                        aria-label={`Move ${idea.title}`}
                        aria-pressed={moving === idea.id}
                        className="drag-grip"
                        onClick={() => {
                          if (pointerDrag.consumeClick()) return;
                          toggleMoving(idea.id);
                        }}
                        type="button"
                      >
                        ⠿
                      </button>
                      <button
                        aria-label={`Make work page from ${idea.title}`}
                        onClick={() => changeSelected(idea.id)}
                        type="button"
                      >
                        make page
                      </button>
                      <button
                        aria-label={`Park ${idea.title}`}
                        onClick={() => void onUpdate(idea.id, { state: "parked" })}
                        type="button"
                      >
                        park
                      </button>
                    </div>
                  </article>
                  {movingIdea && !hidden && (
                    <MoveSlot
                      index={slot + 1}
                      onPlace={placeMoving}
                      slot="shortlist"
                      slotName={stateNames.shortlist}
                      title={movingIdea.title}
                    />
                  )}
                </Fragment>
              );
            })}
            {hintIndex !== null && hintIndex === baseShortlist.length && placeholder}
            {shortlist.length === 0 && hintIndex === null && !movingIdea && (
              <EmptyIdeas>Shortlist only the ideas the team is genuinely considering.</EmptyIdeas>
            )}
          </div>
        </section>

        <section
          aria-label="Idea inbox"
          className={`idea-section inbox-section ${drag && dropHint?.slot === "inbox" ? "drop-ready" : ""} ${moving ? "moving-open" : ""}`}
          ref={(node) => {
            if (node) sectionNodes.current.set("inbox", node);
            else sectionNodes.current.delete("inbox");
          }}
        >
          <header className="idea-section-header">
            <div>
              <span className="idea-glyph">+</span>
              <div>
                <p className="eyebrow">new and unsorted</p>
                <h3>Idea inbox</h3>
              </div>
            </div>
            <span>{inbox.length}</span>
          </header>
          <div className="inbox-list">
            {movingIdea && (
              <MoveSlot
                index={0}
                onPlace={placeMoving}
                ranked={false}
                slot="inbox"
                slotName={stateNames.inbox}
                title={movingIdea.title}
              />
            )}
            {inbox.map((idea) => (
              <article
                className={`idea-card ${liftedId === idea.id ? "drag-hidden" : ""} ${isUnseen(idea.id) ? "unseen" : ""}`}
                data-flip-id={idea.id}
                key={idea.id}
                onPointerDown={(event) => pointerDrag.start(event, idea.id)}
              >
                <IdeaOpenButton
                  guardClick={pointerDrag.consumeClick}
                  idea={idea}
                  onOpen={() => changeSelected(idea.id)}
                  unseen={isUnseen(idea.id)}
                />
                <div className="idea-actions">
                  <button
                    aria-label={`Move ${idea.title}`}
                    aria-pressed={moving === idea.id}
                    className="drag-grip"
                    onClick={() => {
                      if (pointerDrag.consumeClick()) return;
                      toggleMoving(idea.id);
                    }}
                    type="button"
                  >
                    ⠿
                  </button>
                  <button
                    aria-label={`Shortlist ${idea.title}`}
                    onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })}
                    type="button"
                  >
                    shortlist
                  </button>
                  <button
                    aria-label={`Park ${idea.title}`}
                    onClick={() => void onUpdate(idea.id, { state: "parked" })}
                    type="button"
                  >
                    park
                  </button>
                </div>
              </article>
            ))}
            {inbox.length === 0 && !movingIdea && (
              <EmptyIdeas>Fresh ideas land here without interrupting current work.</EmptyIdeas>
            )}
          </div>
        </section>

        <section
          aria-label="Parked ideas"
          className={`idea-section parked-section ${drag && dropHint?.slot === "parked" ? "drop-ready" : ""} ${moving ? "moving-open" : ""}`}
          ref={(node) => {
            if (node) sectionNodes.current.set("parked", node);
            else sectionNodes.current.delete("parked");
          }}
        >
          <header className="idea-section-header">
            <div>
              <span className="idea-glyph">·</span>
              <div>
                <p className="eyebrow">kept, not pursued</p>
                <h3>Parked</h3>
              </div>
            </div>
            <span>{parked.length}</span>
          </header>
          <div className="parked-list">
            {movingIdea && (
              <MoveSlot
                index={0}
                onPlace={placeMoving}
                ranked={false}
                slot="parked"
                slotName={stateNames.parked}
                title={movingIdea.title}
              />
            )}
            {parked.map((idea) => (
              <article
                className={`idea-card parked-card ${liftedId === idea.id ? "drag-hidden" : ""} ${isUnseen(idea.id) ? "unseen" : ""}`}
                data-flip-id={idea.id}
                key={idea.id}
                onPointerDown={(event) => pointerDrag.start(event, idea.id)}
              >
                <IdeaOpenButton
                  guardClick={pointerDrag.consumeClick}
                  idea={idea}
                  onOpen={() => changeSelected(idea.id)}
                  unseen={isUnseen(idea.id)}
                />
                <div className="idea-actions">
                  <button
                    aria-label={`Move ${idea.title}`}
                    aria-pressed={moving === idea.id}
                    className="drag-grip"
                    onClick={() => {
                      if (pointerDrag.consumeClick()) return;
                      toggleMoving(idea.id);
                    }}
                    type="button"
                  >
                    ⠿
                  </button>
                  <button
                    aria-label={`Return ${idea.title} to inbox`}
                    onClick={() => void onUpdate(idea.id, { state: "inbox" })}
                    type="button"
                  >
                    return to inbox
                  </button>
                  <button
                    aria-label={`Shortlist ${idea.title}`}
                    onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })}
                    type="button"
                  >
                    shortlist
                  </button>
                </div>
              </article>
            ))}
            {parked.length === 0 && !movingIdea && (
              <EmptyIdeas>Ideas can rest here without being lost.</EmptyIdeas>
            )}
          </div>
        </section>
      </div>

      {pointerDrag.lift && liftedIdea && (
        <LiftedGhost
          cardClass="idea-card"
          labelClass="idea-open"
          lift={pointerDrag.lift}
          title={liftedIdea.title}
        />
      )}

      {selected && (
        <IdeaDialog
          idea={selected}
          shortlistPosition={shortlist.length}
          onClose={() => changeSelected(null)}
          onPromote={async () => {
            await onPromote(selected.id);
            changeSelected(null);
          }}
          onUpdate={(input) => onUpdate(selected.id, input)}
        />
      )}
    </main>
  );
}

function ideasIn(workspace: IdeaWorkspace, state: IdeaState): Idea[] {
  return workspace.ideas
    .filter((idea) => idea.state === state)
    .sort((left, right) => left.position - right.position);
}

function IdeaOpenButton({
  guardClick,
  idea,
  onOpen,
  unseen = false,
}: {
  guardClick: () => boolean;
  idea: Idea;
  onOpen: () => void;
  unseen?: boolean;
}) {
  return (
    <button
      aria-label={`Open idea ${idea.title}${unseen ? ". Changed while you were away" : ""}`}
      className="idea-open"
      onClick={() => {
        if (!guardClick()) onOpen();
      }}
      type="button"
    >
      <strong>{idea.title}</strong>
      {idea.description && <p>{plainTextFromMarkdown(idea.description)}</p>}
      <span>captured by {idea.createdByName}</span>
    </button>
  );
}

function EmptyIdeas({ children }: { children: string }) {
  return <div className="empty-ideas">{children}</div>;
}

function IdeaDialog({
  idea,
  shortlistPosition,
  onUpdate,
  onPromote,
  onClose,
}: {
  idea: Idea;
  shortlistPosition: number;
  onUpdate: (input: Record<string, unknown>) => Promise<void>;
  onPromote: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmPromotion, setConfirmPromotion] = useState(false);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  const remote = useMemo(
    () => ({ title: idea.title, description: idea.description }),
    [idea.title, idea.description],
  );
  const editor = useContentEditor({
    remote,
    resetKey: idea.id,
    save: (input) => updateRef.current(input),
  });

  const close = async () => {
    if (await editor.flush()) onClose();
  };

  return (
    <Drawer className="dialog-panel idea-dialog" labelledBy="idea-dialog-title" onClose={close}>
      <header className="dialog-header">
        <div>
          <p className="eyebrow">possibility, not commitment</p>
          <h2 id="idea-dialog-title">Edit idea</h2>
        </div>
        <button aria-label="Close idea" className="icon-button" onClick={() => void close()} type="button">
          ×
        </button>
      </header>
      <div className="record-form">
        <label>
          <span>Title</span>
          <input
            aria-label="Idea title"
            name="ideaTitle"
            onChange={(event) => editor.setTitle(event.target.value)}
            value={editor.title}
          />
        </label>
        <NotesField
          editLabel="Edit idea notes"
          editorLabel="Idea notes"
          label="Notes"
          onChange={editor.setDescription}
          placeholder="What makes this interesting?"
          rows={7}
          value={editor.description}
          viewLabel="View idea notes"
        />
        <SaveState editor={editor} who={null} />
      </div>
      <div className="dialog-section">
        <span className="field-label">Keep it where?</span>
        <div className="choice-grid">
          <button
            className={idea.state === "inbox" ? "choice active" : "choice"}
            onClick={() => onUpdate({ state: "inbox" })}
            type="button"
          >
            inbox
          </button>
          <button
            className={idea.state === "shortlist" ? "choice active" : "choice"}
            onClick={() => onUpdate({ state: "shortlist", position: shortlistPosition })}
            type="button"
          >
            shortlist
          </button>
          <button
            className={idea.state === "parked" ? "choice active" : "choice"}
            onClick={() => onUpdate({ state: "parked" })}
            type="button"
          >
            parked
          </button>
        </div>
      </div>
      <footer className="dialog-footer promotion-footer">
        <span>captured by {idea.createdByName}</span>
        <ConfirmInline
          cancelClass="text-button"
          cancelLabel="cancel"
          className="archive-confirm"
          confirmClass="primary-button compact"
          confirmLabel="yes, make page"
          onCancel={() => setConfirmPromotion(false)}
          onConfirm={onPromote}
          onOpen={() => setConfirmPromotion(true)}
          open={confirmPromotion}
          question="create a backlog page and archive this idea?"
          trigger="make work page"
          triggerClass="primary-button compact"
        />
      </footer>
    </Drawer>
  );
}
