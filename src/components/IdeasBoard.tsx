import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import type { Idea, IdeaState, IdeaWorkspace } from "../../shared/types";

type Props = {
  workspace: IdeaWorkspace;
  busy: boolean;
  onCreate: (input: { title: string }) => Promise<void>;
  onUpdate: (id: string, input: { title?: string; description?: string; state?: IdeaState; position?: number }) => Promise<void>;
  onPromote: (id: string) => Promise<void>;
};

export function IdeasBoard({ workspace, busy, onCreate, onUpdate, onPromote }: Props) {
  const [title, setTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const shortlist = ideasIn(workspace, "shortlist");
  const inbox = ideasIn(workspace, "inbox");
  const parked = ideasIn(workspace, "parked");
  const selected = workspace.ideas.find((idea) => idea.id === selectedId) ?? null;

  const capture = async (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    setTitle("");
    await onCreate({ title: value });
  };

  const moveShortlistIdea = async (event: DragEvent, position: number) => {
    event.preventDefault();
    const id = draggedId ?? event.dataTransfer.getData("text/plain");
    setDraggedId(null);
    if (!id) return;
    const idea = workspace.ideas.find((candidate) => candidate.id === id);
    if (!idea || (idea.state === "shortlist" && idea.position === position)) return;
    await onUpdate(id, { state: "shortlist", position });
  };

  return (
    <main className="ideas-main">
      <div className="ideas-intro">
        <div>
          <h2>Idea garden</h2>
          <p>Keep the strongest possibilities close, and turn one into work only when the team means to build it.</p>
        </div>
        <form className="idea-capture" onSubmit={capture}>
          <label className="sr-only" htmlFor="capture-idea">Capture an idea</label>
          <input id="capture-idea" name="ideaTitle" onChange={(event) => setTitle(event.target.value)} placeholder="Something worth remembering..." value={title} />
          <button className="primary-button" disabled={busy || !title.trim()} type="submit">capture</button>
        </form>
      </div>

      <div className="idea-layout">
        <section aria-label="Shortlist" className="idea-section shortlist-section">
          <header className="idea-section-header">
            <div><span className="idea-glyph">✦</span><div><p className="eyebrow">ranked by hand</p><h3>Shortlist</h3></div></div>
            <span>{shortlist.length}</span>
          </header>
          <div className="shortlist-list" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void moveShortlistIdea(event, shortlist.length)}>
            {shortlist.map((idea, index) => (
              <article
                className={`idea-card shortlist-card ${draggedId === idea.id ? "dragging" : ""}`}
                draggable
                key={idea.id}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={(event) => {
                  setDraggedId(idea.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", idea.id);
                }}
                onDrop={(event) => { event.stopPropagation(); void moveShortlistIdea(event, index); }}
              >
                <span className="rank-number">{String(index + 1).padStart(2, "0")}</span>
                <IdeaOpenButton idea={idea} onOpen={() => setSelectedId(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Make work card from ${idea.title}`} onClick={() => setSelectedId(idea.id)} type="button">make card</button>
                  <button aria-label={`Park ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "parked" })} type="button">park</button>
                </div>
              </article>
            ))}
            {shortlist.length === 0 && <EmptyIdeas>Shortlist only the ideas the team is genuinely considering.</EmptyIdeas>}
          </div>
        </section>

        <section aria-label="Idea inbox" className="idea-section inbox-section">
          <header className="idea-section-header">
            <div><span className="idea-glyph">+</span><div><p className="eyebrow">new and unsorted</p><h3>Idea inbox</h3></div></div>
            <span>{inbox.length}</span>
          </header>
          <div className="inbox-list">
            {inbox.map((idea) => (
              <article className="idea-card" key={idea.id}>
                <IdeaOpenButton idea={idea} onOpen={() => setSelectedId(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Shortlist ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })} type="button">shortlist</button>
                  <button aria-label={`Park ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "parked" })} type="button">park</button>
                </div>
              </article>
            ))}
            {inbox.length === 0 && <EmptyIdeas>Fresh ideas land here without interrupting current work.</EmptyIdeas>}
          </div>
        </section>

        <section aria-label="Parked ideas" className="idea-section parked-section">
          <header className="idea-section-header">
            <div><span className="idea-glyph">·</span><div><p className="eyebrow">kept, not pursued</p><h3>Parked</h3></div></div>
            <span>{parked.length}</span>
          </header>
          <div className="parked-list">
            {parked.map((idea) => (
              <article className="idea-card parked-card" key={idea.id}>
                <IdeaOpenButton idea={idea} onOpen={() => setSelectedId(idea.id)} />
                <div className="idea-actions">
                  <button aria-label={`Return ${idea.title} to inbox`} onClick={() => void onUpdate(idea.id, { state: "inbox" })} type="button">return to inbox</button>
                  <button aria-label={`Shortlist ${idea.title}`} onClick={() => void onUpdate(idea.id, { state: "shortlist", position: shortlist.length })} type="button">shortlist</button>
                </div>
              </article>
            ))}
            {parked.length === 0 && <EmptyIdeas>Ideas can rest here without being lost.</EmptyIdeas>}
          </div>
        </section>
      </div>

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

function ideasIn(workspace: IdeaWorkspace, state: IdeaState): Idea[] {
  return workspace.ideas.filter((idea) => idea.state === state).sort((left, right) => left.position - right.position);
}

function IdeaOpenButton({ idea, onOpen }: { idea: Idea; onOpen: () => void }) {
  return (
    <button aria-label={`Open idea ${idea.title}`} className="idea-open" onClick={onOpen} type="button">
      <strong>{idea.title}</strong>
      {idea.description && <p>{idea.description}</p>}
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
  onUpdate: (input: { title?: string; description?: string; state?: IdeaState; position?: number }) => Promise<void>;
  onPromote: () => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(idea.title);
  const [description, setDescription] = useState(idea.description);
  const [saveState, setSaveState] = useState("saved");
  const [confirmPromotion, setConfirmPromotion] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef({ title: idea.title, description: idea.description });

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = { title: title.trim(), description: description.trim() };
    if (!next.title) { setSaveState("title required"); return; }
    if (next.title === lastSavedRef.current.title && next.description === lastSavedRef.current.description) {
      setSaveState("saved");
      return;
    }
    setSaveState("changes pending");
    timerRef.current = setTimeout(() => {
      setSaveState("saving...");
      void onUpdate(next).then(() => {
        lastSavedRef.current = next;
        setSaveState("saved");
      }).catch(() => setSaveState("save failed"));
    }, 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [description, title]);

  const close = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = { title: title.trim(), description: description.trim() };
    if (!next.title) { setSaveState("title required"); return; }
    if (next.title !== lastSavedRef.current.title || next.description !== lastSavedRef.current.description) {
      try { await onUpdate(next); } catch { setSaveState("save failed"); return; }
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section aria-labelledby="idea-dialog-title" aria-modal="true" className="card-dialog idea-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">possibility, not commitment</p><h2 id="idea-dialog-title">Edit idea</h2></div>
          <button aria-label="Close idea" className="icon-button" onClick={() => void close()} type="button">×</button>
        </header>
        <div className="card-form">
          <label><span>Title</span><input aria-label="Idea title" name="ideaTitle" onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label><span>Notes</span><textarea aria-label="Idea notes" name="ideaDescription" onChange={(event) => setDescription(event.target.value)} placeholder="What makes this interesting?" rows={7} value={description} /></label>
          <div aria-live="polite" className={`autosave-state ${saveState.replaceAll(" ", "-")}`}><span className="autosave-dot" />{saveState}</div>
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
            <div className="archive-confirm"><span>create a backlog card and archive this idea?</span><button className="primary-button compact" onClick={onPromote} type="button">yes, make card</button><button className="text-button" onClick={() => setConfirmPromotion(false)} type="button">cancel</button></div>
          ) : <button className="primary-button compact" onClick={() => setConfirmPromotion(true)} type="button">make work card</button>}
        </footer>
      </section>
    </div>
  );
}
