import { useState } from "react";
import type { Member, User, ProjectRole } from "../../shared/types";
import { Avatar } from "./Avatar";
import { Growing } from "./Growing";
import type { SettingsRun } from "./use-settings-action";

type Props = {
  currentUser: User;
  /**
   * Whether the reader owns the project on screen. It arrives as a prop because the account
   * beside it no longer answers the question: owning a project is a fact about that project,
   * and the server is the only thing that knows it.
   */
  isOwner: boolean;
  members: Member[];
  online: ReadonlySet<string>;
  busy: boolean;
  onCreateInvite: () => Promise<string>;
  onChangeMemberRole: (id: string, role: ProjectRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  run: SettingsRun;
};

export function TeamSection({ currentUser, isOwner, members, online, busy, onCreateInvite, onChangeMemberRole, onRemoveMember, run }: Props) {
  const [invite, setInvite] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  /**
   * Promotion is one button rather than a confirm, because it is reversible by the same
   * button. Removal keeps its confirm: that one takes a person off the board.
   */
  const changeRole = (member: Member) =>
    void run(
      () => onChangeMemberRole(member.id, member.projectRole === "owner" ? "member" : "owner"),
      `${member.name}'s role could not be changed`,
    );

  return (
    <div className="settings-section">
      <div className="team-list">
        {members.map((member) => (
          <Growing className="team-member" key={member.id}>
            <Avatar avatarUrl={member.avatarUrl} name={member.name} online={online.has(member.id)} />
            <div className="team-member-copy">
              <strong>{member.name}{online.has(member.id) && <span className="member-online">online</span>}</strong>
              <span>{member.email}</span>
            </div>
            {isOwner && member.id !== currentUser.id ? (
              <div className="member-actions">
                {removingId === member.id ? (
                  <>
                    <span>remove?</span>
                    <button
                      aria-label={`Confirm remove ${member.name}`}
                      className="danger-text"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await onRemoveMember(member.id);
                        setRemovingId(null);
                      }, `${member.name} could not be removed`)}
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
                      onClick={() => changeRole(member)}
                      type="button"
                    >{member.projectRole === "owner" ? "make member" : "make owner"}</button>
                    <button aria-label={`Remove ${member.name}`} className="member-remove" onClick={() => setRemovingId(member.id)} type="button">remove</button>
                  </>
                )}
              </div>
            ) : <span className="member-role">{member.projectRole}</span>}
          </Growing>
        ))}
      </div>
      {isOwner && (
        <>
          {/* The reach is named where the button lives, because the reach is the part people
              assume - and what they assume is bigger than what this grants. */}
          <p className="settings-summary role-reach-note">
            An owner can reshape this project. The role reaches this project only: it grants nothing
            anywhere else, and adds them to nothing.
          </p>
          <div className="invite-box">
            <div><span className="field-label">Invite someone</span><p>One person can use this link. Creating another revokes this one. It expires after seven days.</p></div>
            {!invite ? (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void run(async () => setInvite(await onCreateInvite()), "The invitation could not be created")}
                type="button"
              >create invite</button>
            ) : (
              <div className="invite-link"><input aria-label="Invite link" name="inviteLink" readOnly value={invite} /><button className="quiet-button" onClick={() => navigator.clipboard?.writeText(invite)} type="button">copy</button></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
