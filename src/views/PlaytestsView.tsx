import { FormEvent, useState } from "react";
import type { ViewProps } from "./types";
import { EmptyState, PageHeading, PanelHeading } from "./OverviewView";

export function PlaytestsView({ workspace, runMutation, busy }: ViewProps) {
  const [showBuild, setShowBuild] = useState(false);
  const [showPlaytest, setShowPlaytest] = useState(false);
  const [buildName, setBuildName] = useState("");
  const [summary, setSummary] = useState("");
  const [testTitle, setTestTitle] = useState("");
  const [observations, setObservations] = useState("");
  const [decision, setDecision] = useState("undecided");
  const [outcomeId, setOutcomeId] = useState("");
  const [buildId, setBuildId] = useState("");

  const createBuild = async (event: FormEvent) => { event.preventDefault(); await runMutation("/api/builds", "POST", { name: buildName, summary }); setBuildName(""); setSummary(""); setShowBuild(false); };
  const createPlaytest = async (event: FormEvent) => { event.preventDefault(); await runMutation("/api/playtests", "POST", { title: testTitle, observations, decision, outcomeId: outcomeId || null, buildId: buildId || null }); setTestTitle(""); setObservations(""); setShowPlaytest(false); };

  return (
    <>
      <PageHeading eyebrow="evidence and decisions" title="Progress is what became playable" copy="Record meaningful builds, observe them, and keep the decision beside the evidence.">
        <div className="button-row"><button className="secondary-button" onClick={() => setShowBuild(true)} type="button">record build</button><button className="primary-button" onClick={() => setShowPlaytest(true)} type="button">record playtest</button></div>
      </PageHeading>
      {showBuild && <form className="panel inline-create" onSubmit={createBuild}><label><span>Build name</span><input name="buildName" value={buildName} onChange={(e) => setBuildName(e.target.value)} required /></label><label><span>What became playable</span><textarea name="buildSummary" value={summary} onChange={(e) => setSummary(e.target.value)} /></label><div className="form-actions"><button className="secondary-button" onClick={() => setShowBuild(false)} type="button">cancel</button><button className="primary-button" disabled={busy} type="submit">save build</button></div></form>}
      {showPlaytest && <form className="panel inline-create three-column" onSubmit={createPlaytest}><label><span>Playtest title</span><input name="playtestTitle" value={testTitle} onChange={(e) => setTestTitle(e.target.value)} required /></label><label><span>Build</span><select name="buildId" value={buildId} onChange={(e) => setBuildId(e.target.value)}><option value="">none</option>{workspace.builds.map((build) => <option key={build.id} value={build.id}>{build.name}</option>)}</select></label><label><span>Outcome</span><select name="outcomeId" value={outcomeId} onChange={(e) => setOutcomeId(e.target.value)}><option value="">none</option>{workspace.outcomes.map((outcome) => <option key={outcome.id} value={outcome.id}>{outcome.title}</option>)}</select></label><label className="wide"><span>Observations</span><textarea name="observations" value={observations} onChange={(e) => setObservations(e.target.value)} required /></label><label><span>Decision</span><select name="decision" value={decision} onChange={(e) => setDecision(e.target.value)}><option>undecided</option><option>keep</option><option>revise</option><option>cut</option></select></label><div className="form-actions"><button className="secondary-button" onClick={() => setShowPlaytest(false)} type="button">cancel</button><button className="primary-button" disabled={busy} type="submit">save playtest</button></div></form>}
      <div className="evidence-grid">
        <section className="panel"><PanelHeading eyebrow="build history" title={`${workspace.builds.length} snapshots`} /><div className="timeline-list">{workspace.builds.map((build) => <article className="timeline-entry" key={build.id}><span className="timeline-dot" /><div><h3>{build.name}</h3><p>{build.summary || "No summary recorded."}</p><small>{new Date(build.builtAt).toLocaleDateString()} · {build.creatorName}</small>{build.knownIssues && <div className="known-issues">known: {build.knownIssues}</div>}</div></article>)}{workspace.builds.length === 0 && <EmptyState text="No build snapshots recorded yet." />}</div></section>
        <section className="panel"><PanelHeading eyebrow="playtest record" title={`${workspace.playtests.length} observations`} /><div className="timeline-list">{workspace.playtests.map((test) => <article className="timeline-entry" key={test.id}><span className={`timeline-dot ${test.decision}`} /><div><div className="entry-title"><h3>{test.title}</h3><span className={`state ${test.decision}`}>{test.decision}</span></div><p>{test.observations}</p><small>{new Date(test.playedAt).toLocaleDateString()} · {test.creatorName}</small></div></article>)}{workspace.playtests.length === 0 && <EmptyState text="No playtest evidence recorded yet." />}</div></section>
      </div>
    </>
  );
}
