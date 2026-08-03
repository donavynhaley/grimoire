import { FormEvent, useState } from "react";
import type { ViewProps } from "./types";
import { EmptyState, PageHeading } from "./OverviewView";

export function AssetsView({ workspace, runMutation, busy }: ViewProps) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("prop");
  const [outcomeId, setOutcomeId] = useState("");
  const [stages, setStages] = useState("model, texture, godot import, in-game review");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation("/api/assets", "POST", {
      name,
      type,
      outcomeId: outcomeId || null,
      ownerId: workspace.currentUser.id,
      stageLabels: stages.split(",").map((item) => item.trim()).filter(Boolean),
    });
    setName(""); setShowNew(false);
  };

  return (
    <>
      <PageHeading eyebrow="asset production" title="Every file has a path into the game" copy="Track source work, ownership, and the handoffs required before an asset is actually integrated.">
        <button className="primary-button" onClick={() => setShowNew(true)} type="button">new asset</button>
      </PageHeading>
      {showNew && (
        <form className="panel inline-create three-column" onSubmit={create}>
          <label><span>Asset name</span><input name="assetName" value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label><span>Type</span><select name="assetType" value={type} onChange={(e) => setType(e.target.value)}><option>prop</option><option>environment</option><option>character</option><option>animation</option><option>audio</option><option>writing</option></select></label>
          <label><span>Linked outcome</span><select name="outcomeId" value={outcomeId} onChange={(e) => setOutcomeId(e.target.value)}><option value="">none</option>{workspace.outcomes.map((outcome) => <option value={outcome.id} key={outcome.id}>{outcome.title}</option>)}</select></label>
          <label className="wide"><span>Pipeline stages</span><input name="pipelineStages" value={stages} onChange={(e) => setStages(e.target.value)} /></label>
          <div className="wide form-actions"><button className="secondary-button" onClick={() => setShowNew(false)} type="button">cancel</button><button className="primary-button" disabled={busy} type="submit">create asset</button></div>
        </form>
      )}
      <div className="asset-list">
        {workspace.assets.map((asset) => (
          <article className="panel asset-card" key={asset.id}>
            <header><div><p className="eyebrow">{asset.type}</p><h2>{asset.name}</h2></div><span className={`state ${asset.status}`}>{asset.status}</span></header>
            {asset.notes && <p className="panel-description">{asset.notes}</p>}
            <div className="asset-pipeline">
              {asset.stages.map((stage, index) => (
                <div className={`asset-stage ${stage.status}`} key={stage.id}>
                  <div className="stage-line"><span className="stage-number">{index + 1}</span><span className="connector" /></div>
                  <strong>{stage.label}</strong><span>{stage.ownerName ?? "unassigned"}</span>
                  <select aria-label={`status for ${asset.name} ${stage.label}`} name={`stage-status-${stage.id}`} value={stage.status} onChange={(e) => runMutation(`/api/asset-stages/${stage.id}`, "PATCH", { status: e.target.value })}><option>waiting</option><option>ready</option><option>doing</option><option>review</option><option>done</option></select>
                  {stage.handoffNote && <small>{stage.handoffNote}</small>}
                </div>
              ))}
            </div>
          </article>
        ))}
        {workspace.assets.length === 0 && <div className="panel"><EmptyState text="Create the first asset pipeline when production work begins." /></div>}
      </div>
    </>
  );
}
