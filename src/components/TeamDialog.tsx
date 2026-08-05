import { useState } from "react";
import type { Member, User } from "../../shared/types";
import { Avatar } from "./Avatar";

type Props = {
  currentUser: User;
  members: Member[];
  onCreateInvite: () => Promise<string>;
  onRemoveMember: (id: string) => Promise<void>;
  onClose: () => void;
};

export function TeamDialog({ currentUser, members, onCreateInvite, onRemoveMember, onClose }: Props) {
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");

  const createInvite = async () => {
    setBusy(true);
    try {
      setInvite(await onCreateInvite());
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: Member) => {
    setBusy(true);
    setRemoveError("");
    try {
      await onRemoveMember(member.id);
      setRemovingId(null);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : `${member.name} could not be removed`);
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
              <Avatar avatarUrl={member.avatarUrl} name={member.name} />
              <div className="team-member-copy"><strong>{member.name}</strong><span>{member.email}</span></div>
              {currentUser.role === "owner" && member.id !== currentUser.id ? (
                <div className="member-actions">
                  {removingId === member.id ? (
                    <>
                      <span>remove?</span>
                      <button
                        aria-label={`Confirm remove ${member.name}`}
                        className="danger-text"
                        disabled={busy}
                        onClick={() => void removeMember(member)}
                        type="button"
                      >yes</button>
                      <button aria-label={`Cancel removing ${member.name}`} disabled={busy} onClick={() => setRemovingId(null)} type="button">no</button>
                    </>
                  ) : (
                    <button aria-label={`Remove ${member.name}`} className="member-remove" onClick={() => setRemovingId(member.id)} type="button">remove</button>
                  )}
                </div>
              ) : <span className="member-role">{member.projectRole}</span>}
            </div>
          ))}
        </div>
        {removeError && <div className="error-banner team-error" role="alert">{removeError}</div>}
        {currentUser.role === "owner" && (
          <div className="invite-box">
            <div><span className="field-label">Invite someone</span><p>One person can use this link. Creating another revokes this one. It expires after seven days.</p></div>
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
