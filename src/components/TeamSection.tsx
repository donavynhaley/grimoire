import { useState } from "react";
import type { Member, ProjectRole, User } from "../../shared/types";
import type { SettingsRun } from "../hooks/use-settings-action";
import { Avatar } from "./Avatar";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";

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
  onAddMember: (email: string) => Promise<void>;
  onCreateInvite: () => Promise<string>;
  onChangeMemberRole: (id: string, role: ProjectRole) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  run: SettingsRun;
};

export function TeamSection({
  currentUser,
  isOwner,
  members,
  online,
  busy,
  onAddMember,
  onCreateInvite,
  onChangeMemberRole,
  onRemoveMember,
  run,
}: Props) {
  const [invite, setInvite] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  /**
   * Adding somebody who already has an account, which an invitation cannot do: it only ever
   * makes one, and refuses an address that already has one. The field clears only when the
   * add succeeds, so a refusal leaves the address there to correct rather than retype.
   */
  const addMember = () => {
    const email = addEmail.trim();
    if (!email) return;
    void run(async () => {
      await onAddMember(email);
      setAddEmail("");
    }, `${email} could not be added to this project`);
  };

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
              {/*
               * The admin sits beside the name rather than in the role column, because it is
               * a fact about the installation and the column is about this project. Without
               * it the one account that can reach everything reads as an ordinary owner, and
               * there is nowhere else in the product that says otherwise.
               */}
              <strong>
                {member.name}
                {member.role === "admin" && <span className="member-admin">admin</span>}
                {online.has(member.id) && <span className="member-online">online</span>}
              </strong>
              <span>{member.email}</span>
            </div>
            {isOwner && member.id !== currentUser.id ? (
              <div className="member-actions">
                {removingId !== member.id && (
                  <>
                    <span className="member-role">{member.projectRole}</span>
                    <button
                      aria-label={
                        member.projectRole === "owner"
                          ? `Make ${member.name} a member`
                          : `Make ${member.name} an owner`
                      }
                      className="member-role-change"
                      disabled={busy}
                      onClick={() => changeRole(member)}
                      type="button"
                    >
                      {member.projectRole === "owner" ? "make member" : "make owner"}
                    </button>
                  </>
                )}
                <ConfirmInline
                  cancelAriaLabel={`Cancel removing ${member.name}`}
                  cancelDisabled={busy}
                  confirmAriaLabel={`Confirm remove ${member.name}`}
                  confirmDisabled={busy}
                  onCancel={() => setRemovingId(null)}
                  onConfirm={() =>
                    void run(async () => {
                      await onRemoveMember(member.id);
                      setRemovingId(null);
                    }, `${member.name} could not be removed`)
                  }
                  onOpen={() => setRemovingId(member.id)}
                  open={removingId === member.id}
                  question="remove?"
                  trigger="remove"
                  triggerAriaLabel={`Remove ${member.name}`}
                  triggerClass="member-remove"
                />
              </div>
            ) : (
              <span className="member-role">{member.projectRole}</span>
            )}
          </Growing>
        ))}
      </div>
      {isOwner && (
        <>
          {/* The reach is named where the button lives, because the reach is the part people
              assume - and what they assume is bigger than what this grants. */}
          <p className="settings-summary role-reach-note">
            An owner can reshape this project. The role reaches this project only: it grants nothing anywhere
            else, and adds them to nothing.
          </p>
          {/*
           * Two ways in, because they answer different questions: somebody who already has
           * an account needs adding, not inviting, and an invitation would refuse them.
           */}
          <div className="invite-box">
            <div>
              <span className="field-label">Add someone already on Grimoire</span>
              <p>
                They join this project as a member. Nothing is sent; it is simply there next time they look.
              </p>
            </div>
            <form
              className="member-add"
              onSubmit={(event) => {
                event.preventDefault();
                addMember();
              }}
            >
              <input
                aria-label="Email address"
                autoComplete="off"
                disabled={busy}
                name="memberEmail"
                onChange={(event) => setAddEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                value={addEmail}
              />
              <button className="quiet-button" disabled={busy || !addEmail.trim()} type="submit">
                add
              </button>
            </form>
          </div>
          <div className="invite-box">
            <div>
              <span className="field-label">Invite someone new</span>
              <p>
                One person can use this link. Creating another revokes this one. It expires after seven days.
              </p>
            </div>
            {!invite ? (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    async () => setInvite(await onCreateInvite()),
                    "The invitation could not be created",
                  )
                }
                type="button"
              >
                create invite
              </button>
            ) : (
              <div className="invite-link">
                <input aria-label="Invite link" name="inviteLink" readOnly value={invite} />
                <button
                  className="quiet-button"
                  onClick={() => navigator.clipboard?.writeText(invite)}
                  type="button"
                >
                  copy
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
