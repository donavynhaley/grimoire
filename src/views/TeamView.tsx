import { useState } from "react";
import { mutate } from "../api/client";
import type { ViewProps } from "./types";
import { PageHeading } from "./OverviewView";

export function TeamView({ workspace }: ViewProps) {
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const createInvite = async () => {
    setBusy(true);
    try {
      const result = await mutate<{ code: string }>("/api/invites", "POST", {});
      setInvite(`${location.origin}/?invite=${result.code}`);
    } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeading eyebrow="project team" title="Clear ownership, shared direction" copy="Invite collaborators and keep each person's active responsibilities visible." />
      <section className="team-grid">{workspace.members.map((member) => { const work = workspace.workItems.filter((item) => item.ownerId === member.id && item.status !== "done"); return <article className="panel member-card" key={member.id}><span className="avatar large">{member.name[0]}</span><div><h2>{member.name}</h2><p>{member.projectRole}</p></div><strong>{work.length}</strong><span>open responsibilities</span></article>; })}</section>
      {workspace.currentUser.role === "owner" && <section className="panel invite-panel"><div><p className="eyebrow">invite-only access</p><h2>Bring someone into Wizard Simulator</h2><p>Invite links expire after seven days and can be used once.</p></div><button className="primary-button" disabled={busy} onClick={createInvite} type="button">create invite link</button>{invite && <div className="invite-result"><input aria-label="Invite link" readOnly value={invite} /><button className="secondary-button" onClick={() => navigator.clipboard?.writeText(invite)} type="button">copy</button></div>}</section>}
    </>
  );
}

