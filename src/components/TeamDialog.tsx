import { useState } from "react";
import type { Member, User, UserRole } from "../../shared/types";
import { Avatar } from "./Avatar";
import { useDialogEscape } from "./use-dialog-escape";

type Props = {
  currentUser: User;
  members: Member[];
  online: ReadonlySet<string>;
  onCreateInvite: () => Promise<string>;
  onChangeMemberRole: (id: string, role: UserRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onClose: () => void;
};

export function TeamDialog({ currentUser, members, online, onCreateInvite, onChangeMemberRole, onRemoveMember, onClose }: Props) {
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

  /**
   * Promotion is one button rather than a confirm, because it is reversible by the same
   * button. Removal keeps its confirm: that one takes a person off the board.
   */
  const changeRole = async (member: Member) => {
    setBusy(true);
    setRemoveError("");
    try {
      await onChangeMemberRole(member.id, member.projectRole === "owner" ? "member" : "owner");
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : `${member.name}'s role could not be changed`);
    } finally {
      setBusy(false);
    }
  };

  useDialogEscape(onClose);

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
              <Avatar avatarUrl={member.avatarUrl} name={member.name} online={online.has(member.id)} />
              <div className="team-member-copy">
                <strong>{member.name}{online.has(member.id) && <span className="member-online">online</span>}</strong>
                <span>{member.email}</span>
              </div>
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
                    <>
                      <span className="member-role">{member.projectRole}</span>
                      <button
                        aria-label={member.projectRole === "owner" ? `Make ${member.name} a member` : `Make ${member.name} an owner`}
                        className="member-role-change"
                        disabled={busy}
                        onClick={() => void changeRole(member)}
                        type="button"
                      >{member.projectRole === "owner" ? "make member" : "make owner"}</button>
                      <button aria-label={`Remove ${member.name}`} className="member-remove" onClick={() => setRemovingId(member.id)} type="button">remove</button>
                    </>
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
