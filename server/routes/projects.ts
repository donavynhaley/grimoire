import { randomUUID } from "node:crypto";

import { createProject, withTransaction } from "../database";
import { forgetOpenPullRequests, normalizeRepo } from "../github";
import { HttpError, json, readJson, requestClientId } from "../http";
import { chaptersEnabled, setChaptersEnabled } from "../repository/chapters";
import { projectGithubConfig, setProjectGithub } from "../repository/github";
import {
  archiveProject,
  estimatesEnabled,
  listArchivedProjects,
  listProjectsForUser,
  projectById,
  projectRecapConfig,
  renameProject,
  restoreProject,
  setEstimatesEnabled,
  setProjectDescription,
  setProjectRecap,
  userOwnsProject,
} from "../repository/projects";
import { projectSchema, projectUpdateSchema } from "../schemas";
import { createOpaqueToken, hashToken } from "../security";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

const projectPattern = /^\/api\/projects\/([^/]+)$/;
const projectRestorePattern = /^\/api\/projects\/([^/]+)\/restore$/;

/** The projects themselves: invitations in, settings, archiving and restoring. */
export function projectRoutes(app: AppContext): Route[] {
  const { database } = app;
  return [
    {
      method: "POST",
      pattern: "/api/invites",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(
          context,
          user,
          "Only the project owner can create invitations",
        );
        await readJson(context.request);
        const code = createOpaqueToken();
        const now = new Date();
        const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        withTransaction(database, () => {
          database
            .prepare("DELETE FROM invites WHERE created_by = ? AND project_id = ? AND used_by IS NULL")
            .run(user.id, projectId);
          database
            .prepare(
              "INSERT INTO invites (id, code_hash, created_by, project_id, expires_at, used_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
            )
            .run(randomUUID(), hashToken(code), user.id, projectId, expires.toISOString(), now.toISOString());
        });
        app.audit(context, {
          projectId,
          entityType: "member",
          entityId: null,
          entityTitle: "invitation link",
          action: "invited",
        });
        json(context.response, 201, { code, expiresAt: expires.toISOString() });
      },
    },
    {
      method: "GET",
      pattern: "/api/projects",
      handler: (context) => {
        const user = requireUser(context);
        json(context.response, 200, { projects: listProjectsForUser(database, user) });
      },
    },
    {
      method: "POST",
      pattern: "/api/projects",
      handler: async (context) => {
        const user = requireUser(context);
        // Anyone signed in may start a project, and `createProject` writes them in as its
        // owner. Reserving this for a single account is what left ownership nowhere to live
        // but the installation: there was nobody else a project could belong to.
        const input = projectSchema.parse(await readJson(context.request));
        const projectId = createProject(database, user.id, input.name);
        app.audit(context, {
          projectId,
          entityType: "project",
          entityId: projectId,
          entityTitle: input.name,
          action: "created",
        });
        json(context.response, 201, { project: { id: projectId, name: input.name } });
      },
    },
    {
      method: "PATCH",
      pattern: projectPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        app.requireProjectMembership(user, match![1]!);
        if (!userOwnsProject(database, user, match![1]!)) {
          throw new HttpError(403, "Only the owner can change project settings");
        }
        const input = projectUpdateSchema.parse(await readJson(context.request));
        const projectId = match![1]!;
        const before = projectById(database, projectId);
        if (!before) throw new HttpError(404, "Project not found");
        const previousName = String(before.name);
        const changes: Array<{ field: string; from: string | null; to: string | null }> = [];

        if (input.name !== undefined && input.name !== previousName) {
          if (!renameProject(database, projectId, input.name)) throw new HttpError(404, "Project not found");
          changes.push({ field: "name", from: previousName, to: input.name });
        }
        if (input.description !== undefined) {
          const previousDescription = String(before.description ?? "");
          if (input.description !== previousDescription) {
            if (!setProjectDescription(database, projectId, input.description)) {
              throw new HttpError(404, "Project not found");
            }
            changes.push({
              field: "description",
              from: previousDescription || null,
              to: input.description || null,
            });
          }
        }
        if (input.estimatesEnabled !== undefined) {
          const wasEnabled = estimatesEnabled(database, projectId);
          if (wasEnabled !== input.estimatesEnabled) {
            if (!setEstimatesEnabled(database, projectId, input.estimatesEnabled)) {
              throw new HttpError(404, "Project not found");
            }
            changes.push({
              field: "estimates",
              from: wasEnabled ? "on" : "off",
              to: input.estimatesEnabled ? "on" : "off",
            });
          }
        }
        if (input.chaptersEnabled !== undefined) {
          const wasEnabled = chaptersEnabled(database, projectId);
          if (wasEnabled !== input.chaptersEnabled) {
            if (!setChaptersEnabled(database, projectId, input.chaptersEnabled)) {
              throw new HttpError(404, "Project not found");
            }
            changes.push({
              field: "chapters",
              from: wasEnabled ? "on" : "off",
              to: input.chaptersEnabled ? "on" : "off",
            });
          }
        }

        if (input.discordWebhook !== undefined) {
          // The log records that a destination changed, never what it is.
          const had = projectRecapConfig(database, projectId).webhook !== "";
          setProjectRecap(database, projectId, { webhook: input.discordWebhook });
          const has = input.discordWebhook !== "";
          if (had !== has) {
            changes.push({ field: "discord webhook", from: had ? "set" : null, to: has ? "set" : null });
          }
        }
        if (input.recapOnClose !== undefined) {
          const was = projectRecapConfig(database, projectId).onClose;
          if (was !== input.recapOnClose) {
            setProjectRecap(database, projectId, { onClose: input.recapOnClose });
            changes.push({
              field: "recap on close",
              from: was ? "on" : "off",
              to: input.recapOnClose ? "on" : "off",
            });
          }
        }
        if (input.githubRepo !== undefined) {
          const previousRepo = projectGithubConfig(database, projectId).repo;
          const nextRepo = normalizeRepo(input.githubRepo);
          if (nextRepo !== previousRepo) {
            setProjectGithub(database, projectId, { repo: nextRepo });
            changes.push({ field: "github repository", from: previousRepo || null, to: nextRepo || null });
          }
        }
        if (input.githubToken !== undefined) {
          // The log records that a token changed hands, never what it was.
          const hadToken = projectGithubConfig(database, projectId).token !== "";
          setProjectGithub(database, projectId, { token: input.githubToken });
          const hasToken = input.githubToken !== "";
          if (hadToken !== hasToken) {
            changes.push({
              field: "github token",
              from: hadToken ? "set" : null,
              to: hasToken ? "set" : null,
            });
          }
        }

        const name = input.name ?? previousName;
        if (changes.length > 0) {
          app.audit(context, {
            projectId,
            entityType: "project",
            entityId: projectId,
            entityTitle: name,
            action: changes.some((change) => change.field === "name") ? "renamed" : "updated",
            changes,
          });
        }
        const githubAfter = projectGithubConfig(database, projectId);
        json(context.response, 200, {
          project: {
            id: projectId,
            name,
            description: String(projectById(database, projectId)?.description ?? ""),
            chaptersEnabled: chaptersEnabled(database, projectId),
            estimatesEnabled: estimatesEnabled(database, projectId),
            discordWebhookSet: projectRecapConfig(database, projectId).webhook !== "",
            recapOnClose: projectRecapConfig(database, projectId).onClose,
            githubRepo: githubAfter.repo,
            githubTokenSet: githubAfter.token !== "",
          },
        });
        // A freshly pointed-at repository answers now rather than on the next poll, and the
        // list of open pull requests is asked again rather than served from the old answer.
        if (input.githubRepo !== undefined || input.githubToken !== undefined) {
          forgetOpenPullRequests(githubAfter.repo);
        }
        if (githubAfter.repo) void app.runGithubSync(projectId);
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    // The restore list and the restore itself are owner surfaces, like archiving is. Restoring
    // only clears `archived_at`: the pages never left the disk, so nothing else moves.
    {
      method: "GET",
      pattern: "/api/projects/archived",
      handler: (context) => {
        const user = requireUser(context);
        // Exactly the projects the next route would let them restore, so the list never offers
        // a button that is going to be refused.
        json(context.response, 200, { projects: listArchivedProjects(database, user) });
      },
    },
    {
      method: "POST",
      pattern: projectRestorePattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        // Ownership is read off the membership row, which outlives archiving - so this is asked
        // directly rather than through the live-project check, which refuses anything archived.
        if (!userOwnsProject(database, user, match![1]!)) {
          throw new HttpError(404, "Archived project not found");
        }
        await readJson(context.request);
        const restoredName = projectById(database, match![1]!)?.name;
        if (!restoreProject(database, match![1]!)) {
          throw new HttpError(404, "Archived project not found");
        }
        app.audit(context, {
          projectId: match![1]!,
          entityType: "project",
          entityId: match![1]!,
          entityTitle: String(restoredName ?? "project"),
          action: "restored",
        });
        json(context.response, 200, { ok: true });
        app.broadcast(match![1]!, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: projectPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        app.requireProjectMembership(user, match![1]!);
        if (!userOwnsProject(database, user, match![1]!)) {
          throw new HttpError(403, "Only the owner can archive projects");
        }
        await readJson(context.request);
        const archivedName = projectById(database, match![1]!)?.name;
        const result = archiveProject(database, match![1]!);
        if (result === "not_found") throw new HttpError(404, "Project not found");
        if (result === "last_project") throw new HttpError(409, "The last project cannot be archived");
        app.audit(context, {
          projectId: match![1]!,
          entityType: "project",
          entityId: match![1]!,
          entityTitle: String(archivedName ?? "project"),
          action: "archived",
        });
        json(context.response, 200, { ok: true });
        app.broadcast(match![1]!, "work", requestClientId(context.request));
      },
    },
  ];
}
