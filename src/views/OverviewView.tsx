import { FormEvent, useState } from "react";
import type { ViewProps } from "./types";

export function OverviewView({ workspace, runMutation, navigate, busy }: ViewProps) {
  const [idea, setIdea] = useState("");
  const milestone = workspace.milestones.find((item) => item.status === "active") ?? workspace.milestones[0];
  const activeOutcomes = workspace.outcomes.filter((outcome) =>
    ["ready", "active", "playtest", "integrated", "revise"].includes(outcome.status),
  );
  const activeWork = workspace.workItems.filter((item) => ["doing", "review", "ready"].includes(item.status));
  const handoffs = workspace.assets.flatMap((asset) =>
    asset.stages.filter((stage) => ["ready", "review"].includes(stage.status)).map((stage) => ({ asset, stage })),
  );

  const capture = async (event: FormEvent) => {
    event.preventDefault();
    const title = idea.trim();
    if (!title) return;
    await runMutation("/api/ideas", "POST", { title });
    setIdea("");
  };

  return (
    <>
      <PageHeading eyebrow="current direction" title={workspace.project.currentDirection} copy={workspace.project.directionDetail}>
        <span className="focus-chip">active focus</span>
      </PageHeading>

      <form className="capture" onSubmit={capture}>
        <label htmlFor="idea-capture">capture an idea</label>
        <div className="capture-row">
          <input
            id="idea-capture"
            name="idea"
            onChange={(event) => setIdea(event.target.value)}
            placeholder="Write it down without committing to it..."
            value={idea}
          />
          <button className="primary-button" disabled={busy || !idea.trim()} type="submit">save idea</button>
        </div>
      </form>

      <section className="dashboard-grid">
        <article className="panel span-2">
          <PanelHeading eyebrow="current milestone" title={milestone?.title ?? "No active milestone"}>
            {milestone && <span className={`state ${milestone.status}`}>{milestone.status}</span>}
          </PanelHeading>
          {milestone && (
            <>
              <p className="panel-description">{milestone.description}</p>
              <div className="condition-list">
                {milestone.conditions.map((condition) => (
                  <button
                    className={`condition-row ${condition.complete ? "complete" : ""}`}
                    key={condition.id}
                    onClick={() =>
                      runMutation(`/api/milestone-conditions/${condition.id}`, "PATCH", {
                        complete: !condition.complete,
                      })
                    }
                    type="button"
                  >
                    <span className="check" />
                    <span>{condition.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </article>

        <article className="panel">
          <PanelHeading eyebrow="playable outcomes" title={`${activeOutcomes.length} in motion`}>
            <button className="text-button" onClick={() => navigate("outcomes")} type="button">open board</button>
          </PanelHeading>
          <div className="compact-list">
            {activeOutcomes.slice(0, 4).map((outcome) => (
              <div className="compact-row" key={outcome.id}>
                <span className={`status-dot ${outcome.status}`} />
                <div><strong>{outcome.title}</strong><span>{outcome.ownerName ?? "unassigned"}</span></div>
              </div>
            ))}
            {activeOutcomes.length === 0 && <EmptyState text="No outcomes are active yet." />}
          </div>
        </article>

        <article className="panel">
          <PanelHeading eyebrow="idea inbox" title={`${workspace.ideas.filter((item) => item.status === "inbox").length} waiting`}>
            <button className="text-button" onClick={() => navigate("ideas")} type="button">sort ideas</button>
          </PanelHeading>
          <div className="compact-list">
            {workspace.ideas.filter((item) => item.status === "inbox").slice(0, 4).map((item) => (
              <div className="compact-row" key={item.id}>
                <span className="status-dot shaping" />
                <div><strong>{item.title}</strong><span>captured by {item.creatorName}</span></div>
              </div>
            ))}
            {workspace.ideas.every((item) => item.status !== "inbox") && <EmptyState text="The inbox is clear." />}
          </div>
        </article>

        <article className="panel span-2">
          <PanelHeading eyebrow="team focus" title="What everyone can act on">
            <button className="text-button" onClick={() => navigate("my work")} type="button">open my work</button>
          </PanelHeading>
          <div className="work-list">
            {activeWork.slice(0, 6).map((item) => (
              <div className="work-row" key={item.id}>
                <span className="avatar">{(item.ownerName ?? "?")[0]}</span>
                <div className="work-owner"><strong>{item.ownerName ?? "unassigned"}</strong><span>{item.discipline}</span></div>
                <span className="work-task">{item.title}</span>
                <span className={`state ${item.status}`}>{item.status}</span>
              </div>
            ))}
            {activeWork.length === 0 && <EmptyState text="Create an outcome, then add the work needed to make it playable." />}
          </div>
        </article>

        <article className="panel">
          <PanelHeading eyebrow="handoffs" title={`${handoffs.length} ready`}>
            <button className="text-button" onClick={() => navigate("assets")} type="button">open assets</button>
          </PanelHeading>
          <div className="compact-list">
            {handoffs.slice(0, 5).map(({ asset, stage }) => (
              <div className="compact-row" key={stage.id}>
                <span className={`status-dot ${stage.status}`} />
                <div><strong>{stage.label}</strong><span>{asset.name} · {stage.ownerName ?? "unassigned"}</span></div>
              </div>
            ))}
            {handoffs.length === 0 && <EmptyState text="No asset stages are waiting for action." />}
          </div>
        </article>
      </section>

      <section className="panel activity-panel">
        <PanelHeading eyebrow="progress trail" title="Recent project movement" />
        <div className="activity-list">
          {workspace.activity.slice(0, 8).map((entry) => (
            <div className="activity-row" key={entry.id}>
              <span className="activity-time">{formatRelative(entry.createdAt)}</span>
              <span><strong>{entry.actorName}</strong> {entry.action} {entry.entityType}</span>
              <span className="muted truncate">{entry.summary}</span>
            </div>
          ))}
          {workspace.activity.length === 0 && <EmptyState text="Project changes will appear here." />}
        </div>
      </section>
    </>
  );
}

export function PageHeading({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="page-heading">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{copy && <p className="heading-copy">{copy}</p>}</div>
      {children}
    </section>
  );
}

export function PanelHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
      {children}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

function formatRelative(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
