import { issueAgentToken, listAgentTokens, revokeAgentToken } from "../agent-tokens";
import { HttpError, json, readJson, requestClientId } from "../http";
import {
  categoriesForProject,
  createCategory,
  deleteCategory,
  updateCategory,
} from "../repository/categories";
import { createField, deleteField, fieldsForProject, updateField } from "../repository/fields";
import {
  agentTokenCreateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  fieldCreateSchema,
  fieldUpdateSchema,
} from "../schemas";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

const agentTokenPattern = /^\/api\/agent-tokens\/([^/]+)$/;
const categoryPattern = /^\/api\/categories\/([^/]+)$/;
const fieldPattern = /^\/api\/fields\/([^/]+)$/;

/** The owner's configuration surfaces: agent credentials, categories, and fields. */
export function projectConfigRoutes(app: AppContext): Route[] {
  const { database, pageStore } = app;
  const { writeLimiter } = app;
  return [
    // Agent access. Issuing a credential is the owner deciding something may write on their
    // behalf, so an agent can never reach these at all: a token that could mint another
    // token would make revocation meaningless.
    {
      method: "GET",
      pattern: "/api/agent-tokens",
      handler: (context) => {
        const user = requireUser(context);
        const listing = app.requireProjectOwner(context, user, "Only the owner can manage agent access");
        json(context.response, 200, { tokens: listAgentTokens(database, listing) });
      },
    },
    {
      method: "POST",
      pattern: "/api/agent-tokens",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage agent access");
        const input = agentTokenCreateSchema.parse(await readJson(context.request));
        const issued = issueAgentToken(database, {
          projectId,
          userId: user.id,
          name: input.name,
          scope: input.scope,
          expiresAt: input.expiresAt ?? null,
        });
        if (!issued) throw new HttpError(404, "Project not found");
        // Recorded as its own entity type: borrowing "project" here would make the digest
        // tell every member the owner created or removed a project, which is exactly the
        // alarming-and-untrue phrasing the digest copy was written to avoid.
        app.audit(context, {
          projectId,
          entityType: "agent",
          entityId: issued.token.id,
          entityTitle: input.name,
          action: "created",
          changes: [
            { field: "scope", from: null, to: input.scope === "write" ? "read and write" : "read only" },
          ],
        });
        // The only time the secret leaves the server. Nothing stores it but the holder.
        json(context.response, 201, { token: issued.token, secret: issued.secret });
      },
    },
    {
      method: "DELETE",
      pattern: agentTokenPattern,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage agent access");
        const revoked = listAgentTokens(database, projectId).find((token) => token.id === match![1]!);
        if (!revokeAgentToken(database, projectId, match![1]!)) {
          throw new HttpError(404, "Agent token not found");
        }
        writeLimiter.forget(match![1]!);
        app.audit(context, {
          projectId,
          entityType: "agent",
          entityId: match![1]!,
          entityTitle: revoked?.name ?? "an agent",
          action: "removed",
        });
        json(context.response, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/categories",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage categories");
        const input = categoryCreateSchema.parse(await readJson(context.request));
        const result = createCategory(database, projectId, input);
        if (result === "invalid_name")
          throw new HttpError(400, "The category needs a name with letters or numbers");
        if (result === "exists") throw new HttpError(409, "A category with this name already exists");
        app.audit(context, {
          projectId,
          entityType: "category",
          entityId: result.category.slug,
          entityTitle: result.category.name,
          action: "created",
        });
        json(context.response, 201, { category: result.category });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "PATCH",
      pattern: categoryPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage categories");
        const input = categoryUpdateSchema.parse(await readJson(context.request));
        const previous = categoriesForProject(database, projectId).find((value) => value.slug === match![1]!);
        const category = updateCategory(database, projectId, match![1]!, input);
        if (!category) throw new HttpError(404, "Category not found");
        const categoryEdits = previous
          ? [
              ...(previous.name === category.name
                ? []
                : [{ field: "name", from: previous.name, to: category.name }]),
              ...(previous.color === category.color
                ? []
                : [{ field: "color", from: previous.color, to: category.color }]),
            ]
          : [];
        if (categoryEdits.length > 0) {
          app.audit(context, {
            projectId,
            entityType: "category",
            entityId: category.slug,
            entityTitle: category.name,
            action: "updated",
            changes: categoryEdits,
          });
        }
        json(context.response, 200, { category });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: categoryPattern,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can manage categories");
        const removed = categoriesForProject(database, projectId).find((value) => value.slug === match![1]!);
        if (!deleteCategory(database, pageStore, projectId, match![1]!)) {
          throw new HttpError(404, "Category not found");
        }
        app.audit(context, {
          projectId,
          entityType: "category",
          entityId: match![1]!,
          entityTitle: removed?.name ?? match![1]!,
          action: "deleted",
        });
        json(context.response, 200, { ok: true });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    // Defining a field is deciding what the project records about its work, which is the same
    // kind of decision as adding a column would be. An agent fills fields in; it never
    // decides which exist, so these are owner-only and outside the agent allow list.
    {
      method: "POST",
      pattern: "/api/fields",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only an owner can manage fields");
        const input = fieldCreateSchema.parse(await readJson(context.request));
        const result = createField(database, projectId, input);
        if (result === "invalid_label")
          throw new HttpError(400, "The field needs a name with letters or numbers");
        if (result === "needs_options") throw new HttpError(400, "A choice field needs at least one option");
        if (result === "exists") throw new HttpError(409, "A field with this name already exists");
        app.audit(context, {
          projectId,
          entityType: "field",
          entityId: result.field.key,
          entityTitle: result.field.label,
          action: "created",
          changes: [{ field: "type", from: null, to: result.field.type }],
        });
        json(context.response, 201, { field: result.field });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "PATCH",
      pattern: fieldPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only an owner can manage fields");
        const input = fieldUpdateSchema.parse(await readJson(context.request));
        const before = fieldsForProject(database, projectId).find((field) => field.key === match![1]!);
        const result = updateField(database, pageStore, projectId, match![1]!, input);
        if (result === "not_found") throw new HttpError(404, "Field not found");
        if (result === "needs_options") throw new HttpError(400, "A choice field needs at least one option");
        if (result === "type_locked") {
          throw new HttpError(400, "A field can only change type between the two kinds of choice");
        }
        const edits = before
          ? [
              ...(before.label === result.field.label
                ? []
                : [{ field: "name", from: before.label, to: result.field.label }]),
              ...(before.type === result.field.type
                ? []
                : [{ field: "type", from: before.type, to: result.field.type }]),
              ...(before.options.join(", ") === result.field.options.join(", ")
                ? []
                : [
                    {
                      field: "options",
                      from: before.options.join(", "),
                      to: result.field.options.join(", "),
                    },
                  ]),
              ...(before.showOnTile === result.field.showOnTile
                ? []
                : [
                    {
                      field: "on tiles",
                      from: before.showOnTile ? "yes" : "no",
                      to: result.field.showOnTile ? "yes" : "no",
                    },
                  ]),
              // Said out loud, because withdrawing an option silently emptied pages nobody touched.
              ...(result.cleared > 0
                ? [{ field: "pages cleared", from: null, to: String(result.cleared) }]
                : []),
            ]
          : [];
        if (edits.length > 0) {
          app.audit(context, {
            projectId,
            entityType: "field",
            entityId: result.field.key,
            entityTitle: result.field.label,
            action: "updated",
            changes: edits,
          });
        }
        json(context.response, 200, { field: result.field, cleared: result.cleared });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
    {
      method: "DELETE",
      pattern: fieldPattern,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only an owner can manage fields");
        const removed = fieldsForProject(database, projectId).find((field) => field.key === match![1]!);
        const cleared = deleteField(database, pageStore, projectId, match![1]!);
        if (cleared === null) throw new HttpError(404, "Field not found");
        app.audit(context, {
          projectId,
          entityType: "field",
          entityId: match![1]!,
          entityTitle: removed?.label ?? match![1]!,
          action: "deleted",
          changes: cleared > 0 ? [{ field: "pages cleared", from: null, to: String(cleared) }] : [],
        });
        json(context.response, 200, { ok: true, cleared });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
