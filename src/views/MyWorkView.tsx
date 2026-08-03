import type { ViewProps } from "./types";
import { EmptyState, PageHeading } from "./OverviewView";

export function MyWorkView({ workspace, runMutation }: ViewProps) {
  const mine = workspace.workItems.filter((item) => item.ownerId === workspace.currentUser.id);
  const groups = ["doing", "ready", "review", "blocked", "done"] as const;
  return (
    <>
      <PageHeading eyebrow="personal focus" title={`${workspace.currentUser.name}'s work`} copy="The smallest useful answer to what you can act on right now." />
      <div className="my-work-grid">{groups.map((status) => { const items = mine.filter((item) => item.status === status); return <section className="work-group" key={status}><header><span className={`status-dot ${status}`} /><h2>{status}</h2><span>{items.length}</span></header><div>{items.map((item) => { const outcome = workspace.outcomes.find((value) => value.id === item.outcomeId); return <article className="personal-work-card" key={item.id}><p className="eyebrow">{item.discipline}</p><h3>{item.title}</h3><p>{outcome?.title}</p><select aria-label={`status for ${item.title}`} value={item.status} onChange={(e) => runMutation(`/api/work/${item.id}`, "PATCH", { status: e.target.value })}><option>blocked</option><option>ready</option><option>doing</option><option>review</option><option>done</option></select></article>; })}{items.length === 0 && <EmptyState text="Nothing here." />}</div></section>; })}</div>
    </>
  );
}

