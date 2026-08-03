import { FormEvent, useState } from "react";
import type { ViewProps } from "./types";
import { PageHeading, PanelHeading } from "./OverviewView";

export function DirectionView({ workspace, runMutation, busy }: ViewProps) {
  const [project, setProject] = useState(workspace.project);
  const save = (event: FormEvent) => {
    event.preventDefault();
    return runMutation("/api/project", "PATCH", project);
  };
  return (
    <>
      <PageHeading eyebrow="game direction" title="The shared creative constraint" copy="Keep the whole team aligned on what the game is trying to become right now." />
      <form className="panel direction-form" onSubmit={save}>
        <label><span>Game pitch</span><textarea name="pitch" value={project.pitch} onChange={(e) => setProject({ ...project, pitch: e.target.value })} /></label>
        <label><span>Player fantasy</span><textarea name="playerFantasy" value={project.playerFantasy} onChange={(e) => setProject({ ...project, playerFantasy: e.target.value })} /></label>
        <label className="wide"><span>Current direction</span><input name="currentDirection" value={project.currentDirection} onChange={(e) => setProject({ ...project, currentDirection: e.target.value })} /></label>
        <label className="wide"><span>What this means</span><textarea name="directionDetail" value={project.directionDetail} onChange={(e) => setProject({ ...project, directionDetail: e.target.value })} /></label>
        <label className="wide"><span>Explicit non-goals</span><textarea name="nonGoals" value={project.nonGoals} onChange={(e) => setProject({ ...project, nonGoals: e.target.value })} /></label>
        <div className="wide form-actions"><button className="primary-button" disabled={busy} type="submit">save direction</button></div>
      </form>
      <section className="panel page-panel">
        <PanelHeading eyebrow="design pillars" title="What should remain true" />
        <div className="pillar-grid">
          {workspace.pillars.map((pillar, index) => (
            <article className="pillar-card" key={pillar.id}><span>0{index + 1}</span><h3>{pillar.title}</h3><p>{pillar.description}</p></article>
          ))}
        </div>
      </section>
    </>
  );
}
