import { HttpError, json, readJson, requestClientId } from "../http";
import {
  addProjectMember,
  membersForProject,
  removeProjectMember,
  setMemberRole,
} from "../repository/members";
import { memberAddSchema, memberRoleSchema } from "../schemas";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

const memberPattern = /^\/api\/members\/([^/]+)$/;

/** Who is on the project, and with which of the two roles. */
export function memberRoutes(app: AppContext): Route[] {
  const { database, pageStore } = app;
  return [
    {
      method: "POST",
      pattern: "/api/members",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the project owner can add people");
        const input = memberAddSchema.parse(await readJson(context.request));
        const result = addProjectMember(database, projectId, input.email);
        /*
         * Saying which of the two went wrong tells an owner whether an account exists at that
         * address. On an installation nobody can register on without an invitation, and to a
         * caller who already owns a project here, that is not a fact worth withholding - and
         * withholding it would leave a typo and an existing member looking identical.
         */
        if (result === "no_account") throw new HttpError(404, "Nobody here uses that email address");
        if (result === "already_there") throw new HttpError(409, "They are already on this project");
        app.audit(context, {
          projectId,
          entityType: "member",
          entityId: result.added.id,
          entityTitle: result.added.name,
          action: "joined",
        });
        json(context.response, 201, { members: membersForProject(database, projectId).map(app.withAvatar) });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "PATCH",
      pattern: memberPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only an owner can change roles");
        const input = memberRoleSchema.parse(await readJson(context.request));
        // Changing your own role is refused rather than guarded, because the only case worth
        // allowing is the one that strands the project: its sole owner demoting themselves
        // leaves nobody who can ever promote anyone again. A second owner exists to be asked.
        if (match![1]! === user.id) throw new HttpError(409, "Ask another owner to change your own role");
        const member = membersForProject(database, projectId).find((value) => value.id === match![1]!);
        const result = setMemberRole(database, projectId, match![1]!, input.role);
        if (result === "not_found") throw new HttpError(404, "Member not found");
        // The admin is the installation's, not this project's, so no project role may replace it.
        if (result === "admin") throw new HttpError(409, "The admin's role cannot be changed");
        if (result === "updated" && member) {
          app.audit(context, {
            projectId,
            entityType: "member",
            entityId: match![1]!,
            entityTitle: member.name,
            action: "updated",
            // The membership row is the only thing that moved, and it is what this project's
            // log speaks for, so it is the role the entry reports from and to.
            changes: [{ field: "role", from: member.projectRole, to: input.role }],
          });
        }
        json(context.response, 200, { members: membersForProject(database, projectId).map(app.withAvatar) });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: memberPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        await readJson(context.request);
        const projectId = app.requireProjectOwner(context, user, "Only the project owner can remove members");
        const removedMember = membersForProject(database, projectId).find((value) => value.id === match![1]!);
        const result = removeProjectMember(database, pageStore, projectId, match![1]!);
        if (result === "owner") throw new HttpError(409, "The project owner cannot be removed");
        if (result === "admin") throw new HttpError(409, "The admin cannot be removed");
        if (result === "not_found") throw new HttpError(404, "Member not found");
        app.audit(context, {
          projectId,
          entityType: "member",
          entityId: match![1]!,
          entityTitle: removedMember?.name ?? "a member",
          action: "removed",
        });
        app.disconnectUserEvents(match![1]!);
        json(context.response, 200, { ok: true });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
