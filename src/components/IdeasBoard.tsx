import { type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Idea, IdeaState, IdeaWorkspace } from "../../shared/types";
import { EditorState } from "./EditorState";
import { NotesField } from "./NotesField";
import { plainTextFromMarkdown } from "./markdown-text";
import { Drawer } from "./Drawer";
import { useContentEditor } from "./use-content-editor";
import { useFlip } from "./use-flip";
import { type DragPoint, gapIndexIn, pointWithin, usePointerDrag } from "./use-pointer-drag";
import { useTypingFocus } from "./use-typing-focus";

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

export function IdeasBoard({ workspace, busy, openIdea, unseenIdeaIds, onCreate, onUpdate, onPromote }: Props) {
  const focusForTyping = useTypingFocus<HTMLInputElement>();
  const [title, setTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("idea"),
  );
  const [openedUnseen, setOpenedUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const isUnseen = (id: string) => Boolean(unseenIdeaIds?.has(id)) && !openedUnseen.has(id);

  // Arriving from search opens the idea, even if the garden was already on screen.
  useEffect(() => {
    if (openIdea) setSelectedId(openIdea.id);
  }, [openIdea?.token]);

  // Opening an idea answers its dot for the rest of the visit.
  useEffect(() => {
    if (!selectedId) return;
    setOpenedUnseen((current) => {
      if (current.has(selectedId)) return current;
      const next = new Set(current);
      next.add(selectedId);
      return next;
    });
  }, [selectedId]);
  const [drag, setDrag] = useState<{ id: string; height: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ state: IdeaState; index: number } | null>(null);
  /** An idea picked up by tap or key rather than carried, mirroring the work board. */
  const [moving, setMoving] = useState<string | null>(null);
  const sectionNodes = useRef(new Map<IdeaState, HTMLElement>());
  const layoutRef = useRef<HTMLDivElement>(null);
  useFlip(layoutRef);
  const shortlist = ideasIn(workspace, "shortlist");
  const inbox = ideasIn(workspace, "inbox");
  const parked = ideasIn(workspace, "parked");
  const selected = workspace.ideas.find((idea) => idea.id === selectedId) ?? null;

  // The open idea lives in the URL, mirroring how pages become shareable links.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (selected) params.set("idea", selected.id);
    else params.delete("idea");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }, [selected?.id]);
  const liftedId = drag?.id ?? moving;
  const movingIdea = moving ? workspace.ideas.find((idea) => idea.id === moving) ?? null : null;
  const baseShortlist = liftedId ? shortlist.filter((idea) => idea.id !== liftedId) : shortlist;
  const hintIndex = drag && dropHint?.state === "shortlist" ? Math.min(dropHint.index, baseShortlist.length) : null;
  const placeholder = drag
    ? <div aria-hidden="true" className="drop-placeholder" data-flip-id="drop-placeholder" style={{ height: drag.height }} />
    : null;

  const capture = async (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    setTitle("");
    await onCreate({ title: value });
  };

  const finishDrag = () => {
    setDrag(null);
    setDropHint(null);
  };

  /**
   * Which section a point is over, and for the shortlist which gap within it.
   *
   * Only the shortlist is ordered by hand, so it is the only one that has to answer with a
   * position; the inbox and the parked list simply take what they are given.
   */
  const hintAt = (point: DragPoint): { state: IdeaState; index: number } | null => {
    for (const state of IDEA_STATES) {
      const node = sectionNodes.current.get(state);
      if (!node || !pointWithin(node.getBoundingClientRect(), point)) continue;
      if (state !== "shortlist") return { state, index: 0 };
      return { state, index: gapIndexIn(node, "article.shortlist-card:not(.drag-hidden)", point.y) };
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
    if (idea.state === "shortlist" && shortlist.findIndex((candidate) => candidate.id === id) === position) return;
    await onUpdate(id, { state: "shortlist", position });
  };

  const pointerDrag = usePointerDrag({
    onLift: (id, height) => {
      const idea = workspace.ideas.find((candidate) => candidate.id === id);
      setDrag({ id, height });
      setDropHint(idea?.state === "shortlist"
        ? { state: "shortlist", index: Math.max(0, shortlist.findIndex((candidate) => candidate.id === id)) }
        : null);
      setMoving(null);
    },
    onMove: (point) => {
      const hint = hintAt(point);
      setDropHint((current) => (sameHint(current, hint) ? current : hint));
    },
    onDrop: async (point) => {
      const id = drag?.id;
      const hint = hintAt(point) ?? dropHint;
      finishDrag();
      if (!id || !hint) return;
      await placeIdea(id, hint.state, hint.index);
    },
    onCancel: finishDrag,
  });

  const placeMoving = async (state: IdeaState, index: number) => {
    const id = moving;
    setMoving(null);
    if (!id) return;
    await placeIdea(id, state, index);
  };

  const liftedIdea = pointerDrag.lift
    ? workspace.ideas.find((idea) => idea.id === pointerDrag.lift?.id) ?? null
    : null;

  // An idea put down by tap is put down by Escape too.
  useEffect(() => {
    if (!moving) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMoving(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [moving]);

  return (
    <main className="ideas-main">
      {movingIdea && (
        <div className="moving-bar" role="status">
          <span>Moving <strong>{movingIdea.title}</strong> — choose where it goes</span>
          <button className="text-button" onClick={() => setMoving(null)} type="button">cancel <kbd aria-hidden="true">esc</kbd></button>
        </div>
      )}
      <div className="ideas-intro">
        <div>
          <h2>Idea garden</h2>
          <p>Keep the strongest possibilities close, and turn one into work only when the team means to build it.</p>
        </div>
        <form className="idea-capture workspace-capture" onSubmit={capture}>
          <label className="sr-only" htmlFor="capture-idea">Capture an idea</label>
          <input id="capture-idea" ref={focusForTyping} name="ideaTitle" onChange={(event) => setTitle(event.target.value)} placeholder="Something worth remembering..." value={title} />
          <button className="primary-button" disabled={busy || !title.trim()} type="submit">capture</button>
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
            <div><span className="idea-glyph">✦</span><div><p className="eyebrow">ranked by hand</p><h3>Shortlist</h3></div></div>
            <span>{shortlist.length}</span>
          </header>
          <div className="shortlist-list">
            {movingIdea && <IdeaMoveSlot index={0} onPlace={placeMoving} ranked state="shortlist" stateName={stateNames.shortlist} title={movingIdea.title} />}
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
                <IdeaOpenButton guardClick={pointerDrag.consumeClick} idea={idea} onOpen={() => setSelectedId(idea.id)} unseen={isUnseen(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Move ${idea.title}`} aria-pressed={moving === idea.id} className="drag-grip" onClick={() => { if (pointerDrag.consumeClick()) return; setMoving((current) => (current === idea.id ? null : idea.id)); }} type="button">⠿</button>
                  <button aria-label={`Make work page from ${idea.title}`} onClick={() => setSelectedId(idea.id)} type="button">make page</button>
                  <button aria-label={`Park ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "parked" })} type="button">park</button>
                </div>
              </article>
              {movingIdea && !hidden && <IdeaMoveSlot index={slot + 1} onPlace={placeMoving} ranked state="shortlist" stateName={stateNames.shortlist} title={movingIdea.title} />}
              </Fragment>
              );
            })}
            {hintIndex !== null && hintIndex === baseShortlist.length && placeholder}
            {shortlist.length === 0 && hintIndex === null && !movingIdea && <EmptyIdeas>Shortlist only the ideas the team is genuinely considering.</EmptyIdeas>}
          </div>
        </section>

        <section
          aria-label="Idea inbox"
          className={`idea-section inbox-section ${drag && dropHint?.state === "inbox" ? "drop-ready" : ""} ${moving ? "moving-open" : ""}`}
          ref={(node) => {
            if (node) sectionNodes.current.set("inbox", node);
            else sectionNodes.current.delete("inbox");
          }}
        >
          <header className="idea-section-header">
            <div><span className="idea-glyph">+</span><div><p className="eyebrow">new and unsorted</p><h3>Idea inbox</h3></div></div>
            <span>{inbox.length}</span>
          </header>
          <div className="inbox-list">
            {movingIdea && <IdeaMoveSlot index={0} onPlace={placeMoving} ranked={false} state="inbox" stateName={stateNames.inbox} title={movingIdea.title} />}
            {inbox.map((idea) => (
              <article
                className={`idea-card ${liftedId === idea.id ? "drag-hidden" : ""} ${isUnseen(idea.id) ? "unseen" : ""}`}
                data-flip-id={idea.id}
                key={idea.id}
                onPointerDown={(event) => pointerDrag.start(event, idea.id)}
              >
                <IdeaOpenButton guardClick={pointerDrag.consumeClick} idea={idea} onOpen={() => setSelectedId(idea.id)} unseen={isUnseen(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Move ${idea.title}`} aria-pressed={moving === idea.id} className="drag-grip" onClick={() => { if (pointerDrag.consumeClick()) return; setMoving((current) => (current === idea.id ? null : idea.id)); }} type="button">⠿</button>
                  <button aria-label={`Shortlist ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })} type="button">shortlist</button>
                  <button aria-label={`Park ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "parked" })} type="button">park</button>
                </div>
              </article>
            ))}
            {inbox.length === 0 && !movingIdea && <EmptyIdeas>Fresh ideas land here without interrupting current work.</EmptyIdeas>}
          </div>
        </section>

        <section
          aria-label="Parked ideas"
          className={`idea-section parked-section ${drag && dropHint?.state === "parked" ? "drop-ready" : ""} ${moving ? "moving-open" : ""}`}
          ref={(node) => {
            if (node) sectionNodes.current.set("parked", node);
            else sectionNodes.current.delete("parked");
          }}
        >
          <header className="idea-section-header">
            <div><span className="idea-glyph">·</span><div><p className="eyebrow">kept, not pursued</p><h3>Parked</h3></div></div>
            <span>{parked.length}</span>
          </header>
          <div className="parked-list">
            {movingIdea && <IdeaMoveSlot index={0} onPlace={placeMoving} ranked={false} state="parked" stateName={stateNames.parked} title={movingIdea.title} />}
            {parked.map((idea) => (
              <article
                className={`idea-card parked-card ${liftedId === idea.id ? "drag-hidden" : ""} ${isUnseen(idea.id) ? "unseen" : ""}`}
                data-flip-id={idea.id}
                key={idea.id}
                onPointerDown={(event) => pointerDrag.start(event, idea.id)}
              >
                <IdeaOpenButton guardClick={pointerDrag.consumeClick} idea={idea} onOpen={() => setSelectedId(idea.id)} unseen={isUnseen(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Move ${idea.title}`} aria-pressed={moving === idea.id} className="drag-grip" onClick={() => { if (pointerDrag.consumeClick()) return; setMoving((current) => (current === idea.id ? null : idea.id)); }} type="button">⠿</button>
                  <button aria-label={`Return ${idea.title} to inbox`} onClick={() => void onUpdate(idea.id, { state: "inbox" })} type="button">return to inbox</button>
                  <button aria-label={`Shortlist ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })} type="button">shortlist</button>
                </div>
              </article>
            ))}
            {parked.length === 0 && !movingIdea && <EmptyIdeas>Ideas can rest here without being lost.</EmptyIdeas>}
          </div>
        </section>
      </div>

      {pointerDrag.lift && liftedIdea && (
        <div
          aria-hidden="true"
          className="idea-card lifted"
          style={{
            left: pointerDrag.lift.left,
            top: pointerDrag.lift.top,
            width: pointerDrag.lift.width,
            height: pointerDrag.lift.height,
            transform: `translate(${pointerDrag.lift.dx}px, ${pointerDrag.lift.dy}px)`,
          }}
        >
          <span className="idea-open"><strong>{liftedIdea.title}</strong></span>
        </div>
      )}

      {selected && (
        <IdeaDialog
          idea={selected}
          shortlistPosition={shortlist.length}
          onClose={() => setSelectedId(null)}
          onPromote={async () => { await onPromote(selected.id); setSelectedId(null); }}
          onUpdate={(input) => onUpdate(selected.id, input)}
        />
      )}
    </main>
  );
}

function sameHint(
  left: { state: IdeaState; index: number } | null,
  right: { state: IdeaState; index: number } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.state === right.state && left.index === right.index;
}

/**
 * One place a held idea can be put down, matching the work board's slots.
 *
 * The shortlist is ranked, so its slots name a position; the other two sections hold ideas
 * without ordering them, so theirs name only the section.
 */
function IdeaMoveSlot({ index, onPlace, ranked, state, stateName, title }: {
  index: number;
  onPlace: (state: IdeaState, index: number) => Promise<void>;
  ranked: boolean;
  state: IdeaState;
  stateName: string;
  title: string;
}) {
  return (
    <button
      aria-label={ranked ? `Place ${title} in ${stateName}, position ${index + 1}` : `Move ${title} to ${stateName}`}
      className="move-slot"
      onClick={() => void onPlace(state, index)}
      type="button"
    >
      <span aria-hidden="true">place here</span>
    </button>
  );
}

function ideasIn(workspace: IdeaWorkspace, state: IdeaState): Idea[] {
  return workspace.ideas.filter((idea) => idea.state === state).sort((left, right) => left.position - right.position);
}

function IdeaOpenButton({ guardClick, idea, onOpen, unseen = false }: { guardClick: () => boolean; idea: Idea; onOpen: () => void; unseen?: boolean }) {
  return (
    <button aria-label={`Open idea ${idea.title}${unseen ? ". Changed while you were away" : ""}`} className="idea-open" onClick={() => { if (!guardClick()) onOpen(); }} type="button">
      <strong>{idea.title}</strong>
      {idea.description && <p>{plainTextFromMarkdown(idea.description)}</p>}
      <span>captured by {idea.createdByName}</span>
    </button>
  );
}

function EmptyIdeas({ children }: { children: string }) {
  return <div className="empty-ideas">{children}</div>;
}

function IdeaDialog({ idea, shortlistPosition, onUpdate, onPromote, onClose }: {
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
        <div><p className="eyebrow">possibility, not commitment</p><h2 id="idea-dialog-title">Edit idea</h2></div>
        <button aria-label="Close idea" className="icon-button" onClick={() => void close()} type="button">×</button>
      </header>
      <div className="record-form">
        <label><span>Title</span><input aria-label="Idea title" name="ideaTitle" onChange={(event) => editor.setTitle(event.target.value)} value={editor.title} /></label>
        <NotesField
          editLabel="Edit idea notes"
          label="Notes"
          name="ideaDescription"
          onChange={editor.setDescription}
          placeholder="What makes this interesting?"
          rows={7}
          textareaLabel="Idea notes"
          value={editor.description}
        />
        <EditorState editor={editor} who={null} />
      </div>
      <div className="dialog-section">
        <span className="field-label">Keep it where?</span>
        <div className="choice-grid">
          <button className={idea.state === "inbox" ? "choice active" : "choice"} onClick={() => onUpdate({ state: "inbox" })} type="button">inbox</button>
          <button className={idea.state === "shortlist" ? "choice active" : "choice"} onClick={() => onUpdate({ state: "shortlist", position: shortlistPosition })} type="button">shortlist</button>
          <button className={idea.state === "parked" ? "choice active" : "choice"} onClick={() => onUpdate({ state: "parked" })} type="button">parked</button>
        </div>
      </div>
      <footer className="dialog-footer promotion-footer">
        <span>captured by {idea.createdByName}</span>
        {confirmPromotion ? (
          <div className="archive-confirm"><span>create a backlog page and archive this idea?</span><button className="primary-button compact" onClick={onPromote} type="button">yes, make page</button><button className="text-button" onClick={() => setConfirmPromotion(false)} type="button">cancel</button></div>
        ) : <button className="primary-button compact" onClick={() => setConfirmPromotion(true)} type="button">make work page</button>}
      </footer>
    </Drawer>
  );
}
