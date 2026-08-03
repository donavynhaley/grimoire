import { useState } from "react";
import type { Member, User } from "../../shared/types";
import { initials } from "./Board";

type Props = {
  currentUser: User;
  members: Member[];
  onCreateInvite: () => Promise<string>;
  onClose: () => void;
};

export function TeamDialog({ currentUser, members, onCreateInvite, onClose }: Props) {
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);

  const createInvite = async () => {
    setBusy(true);
    try {
      setInvite(await onCreateInvite());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="team-dialog-title" aria-modal="true" className="team-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">project access</p><h2 id="team-dialog-title">Team</h2></div>
          <button aria-label="Close team" className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <div className="team-list">
          {members.map((member) => (
            <div className="team-member" key={member.id}>
              <span className="avatar">{initials(member.name)}</span>
              <div><strong>{member.name}</strong><span>{member.email}</span></div>
              <span className="member-role">{member.projectRole}</span>
            </div>
          ))}
        </div>
        {currentUser.role === "owner" && (
          <div className="invite-box">
            <div><span className="field-label">Invite someone</span><p>One-use links expire after seven days.</p></div>
            {!invite ? (
              <button className="primary-button" disabled={busy} onClick={createInvite} type="button">{busy ? "creating..." : "create invite"}</button>
            ) : (
              <div className="invite-link"><input aria-label="Invite link" name="inviteLink" readOnly value={invite} /><button className="quiet-button" onClick={() => navigator.clipboard?.writeText(invite)} type="button">copy</button></div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
