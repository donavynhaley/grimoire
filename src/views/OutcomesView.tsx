import { FormEvent, useState } from "react";
import type { Outcome, OutcomeStatus } from "../../shared/types";
import type { ViewProps } from "./types";
import { EmptyState, PageHeading } from "./OverviewView";

const columns: Array<{ status: OutcomeStatus; label: string }> = [
  { status: "shaping", label: "shaping" },
  { status: "ready", label: "ready" },
  { status: "active", label: "active" },
  { status: "playtest", label: "playtest" },
  { status: "integrated", label: "integrated" },
  { status: "validated", label: "validated" },
  { status: "revise", label: "revise" },
];

export function OutcomesView({ workspace, runMutation, busy }: ViewProps) {
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<Outcome | null>(null);
  const [title, setTitle] = useState("");
  const [definition, setDefinition] = useState("");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation("/api/outcomes", "POST", {
      title,
      definitionOfPlayable: definition,
      ownerId: workspace.currentUser.id,
      milestoneId: workspace.milestones.find((item) => item.status === "active")?.id,
    });
    setTitle("");
    setDefinition("");
    setShowNew(false);
  };

  return (
    <>
      <PageHeading eyebrow="playable outcomes" title="Move the game, not the ticket count" copy="Every outcome should describe something the team can put in a build and observe.">
        <button className="primary-button" onClick={() => setShowNew(true)} type="button">new outcome</button>
      </PageHeading>

      {showNew && (
        <form className="panel inline-create" onSubmit={create}>
          <label><span>Outcome title</span><input name="outcomeTitle" value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
          <label><span>Definition of playable</span><textarea name="definition" value={definition} onChange={(e) => setDefinition(e.target.value)} required /></label>
          <div className="form-actions"><button className="secondary-button" onClick={() => setShowNew(false)} type="button">cancel</button><button className="primary-button" disabled={busy} type="submit">create outcome</button></div>
        </form>
      )}

      <div className="outcome-board">
        {columns.map((column) => {
          const outcomes = workspace.outcomes.filter((outcome) => outcome.status === column.status);
          return (
            <section className="outcome-column" key={column.status}>
              <header><span className={`status-dot ${column.status}`} /><h2>{column.label}</h2><span>{outcomes.length}</span></header>
              <div className="outcome-cards">
                {outcomes.map((outcome) => {
                  const work = workspace.workItems.filter((item) => item.outcomeId === outcome.id);
                  return (
                    <button className="outcome-card" key={outcome.id} onClick={() => setSelected(outcome)} type="button">
                      <h3>{outcome.title}</h3>
                      <p>{outcome.definitionOfPlayable || outcome.description || "Definition of playable needed."}</p>
                      <div className="progress-strip"><span style={{ width: `${work.length ? (work.filter((item) => item.status === "done").length / work.length) * 100 : 0}%` }} /></div>
                      <div className="card-meta"><span>{outcome.ownerName ?? "unassigned"}</span><span>{work.filter((item) => item.status === "done").length}/{work.length} work</span></div>
                    </button>
                  );
                })}
                {outcomes.length === 0 && <EmptyState text="No outcomes." />}
              </div>
            </section>
          );
        })}
      </div>

      {selected && (
        <OutcomeDrawer
          outcome={workspace.outcomes.find((item) => item.id === selected.id) ?? selected}
          workspace={workspace}
          runMutation={runMutation}
          close={() => setSelected(null)}
          busy={busy}
        />
      )}
    </>
  );
}

function OutcomeDrawer({ outcome, workspace, runMutation, close, busy }: {
  outcome: Outcome;
  workspace: ViewProps["workspace"];
  runMutation: ViewProps["runMutation"];
  close: () => void;
  busy: boolean;
}) {
  const [showWork, setShowWork] = useState(false);
  const [workTitle, setWorkTitle] = useState("");
  const [discipline, setDiscipline] = useState("code");
  const [comment, setComment] = useState("");
  const work = workspace.workItems.filter((item) => item.outcomeId === outcome.id);
  const comments = workspace.comments.filter((item) => item.entityType === "outcome" && item.entityId === outcome.id);

  const addWork = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation("/api/work", "POST", {
      outcomeId: outcome.id,
      title: workTitle,
      discipline,
      ownerId: workspace.currentUser.id,
    });
    setWorkTitle(""); setShowWork(false);
  };
  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation("/api/comments", "POST", { entityType: "outcome", entityId: outcome.id, body: comment });
    setComment("");
  };

  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="drawer" aria-label={`Outcome: ${outcome.title}`}>
        <header><div><p className="eyebrow">playable outcome</p><h2>{outcome.title}</h2></div><button className="icon-button" onClick={close} type="button" aria-label="Close outcome">×</button></header>
        <label><span>Status</span><select name="outcomeStatus" value={outcome.status} onChange={(e) => runMutation(`/api/outcomes/${outcome.id}`, "PATCH", { status: e.target.value })}>{columns.map((column) => <option key={column.status} value={column.status}>{column.label}</option>)}<option value="cut">cut</option></select></label>
        <section className="drawer-section"><p className="eyebrow">definition of playable</p><p>{outcome.definitionOfPlayable || "Not defined yet."}</p></section>
        <section className="drawer-section">
          <div className="section-heading compact"><div><p className="eyebrow">production work</p><h3>{work.length} deliverables</h3></div><button className="text-button accent" onClick={() => setShowWork(!showWork)} type="button">add work</button></div>
          {showWork && <form className="mini-form" onSubmit={addWork}><input aria-label="Work title" name="workTitle" placeholder="Concrete deliverable" value={workTitle} onChange={(e) => setWorkTitle(e.target.value)} required /><select aria-label="Discipline" name="discipline" value={discipline} onChange={(e) => setDiscipline(e.target.value)}><option>code</option><option>integration</option><option>writing</option><option>game design</option><option>3d art</option><option>texturing</option><option>audio</option><option>playtesting</option></select><button className="primary-button" disabled={busy} type="submit">add</button></form>}
          <div className="drawer-work-list">{work.map((item) => <div className="drawer-work" key={item.id}><span className={`status-dot ${item.status}`} /><div><strong>{item.title}</strong><span>{item.discipline} · {item.ownerName ?? "unassigned"}</span></div><select aria-label={`status for ${item.title}`} name={`status-${item.id}`} value={item.status} onChange={(e) => runMutation(`/api/work/${item.id}`, "PATCH", { status: e.target.value })}><option>blocked</option><option>ready</option><option>doing</option><option>review</option><option>done</option></select></div>)}</div>
        </section>
        <section className="drawer-section"><p className="eyebrow">discussion</p><form className="comment-form" onSubmit={addComment}><input aria-label="Add a comment" name="comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Keep the note attached to the outcome..." /><button className="secondary-button" disabled={!comment.trim()} type="submit">comment</button></form>{comments.map((item) => <div className="comment" key={item.id}><strong>{item.authorName}</strong><p>{item.body}</p></div>)}</section>
      </aside>
    </div>
  );
}
