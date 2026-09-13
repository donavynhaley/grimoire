import { z } from "zod";
import { ATTACHMENT_CHUNK_LIMIT } from "../../shared/attachments";
import { agentForToken } from "../agent-tokens";
import type { RequestContext } from "../app-types";
import { sendAttachment } from "../attachment-response";
import { HttpError, json, readJson, requestClientId } from "../http";
import { attachmentInputSchema } from "../page-attachments";
import { projectSlug } from "../repository";
import { findPage } from "../repository/pages";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

const chunkSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(ATTACHMENT_CHUNK_LIMIT / 3) * 4),
  })
  .strict();

export function attachmentRoutes(app: AppContext): Route[] {
  const scope = (context: RequestContext) => {
    const user = requireUser(context);
    const projectId = app.requireProject(context, user);
    app.requireProjectMembership(user, projectId);
    const slug = projectSlug(app.database, projectId);
    if (!slug) throw new HttpError(404, "Board not found");
    return { user, projectId, slug };
  };
  const page = (projectId: string, pageId: string) => {
    const found = findPage(app.database, app.pageStore, projectId, pageId);
    if (!found) throw new HttpError(404, "Page not found");
    return found;
  };
  return [
    {
      method: "GET",
      pattern: /^\/api\/pages\/([^/]+)\/attachments$/,
      handler: (context, match) => {
        const { projectId, slug } = scope(context);
        const found = page(projectId, match![1]!);
        json(context.response, 200, { attachments: app.attachmentStore.list(slug, projectId, found.id) });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pages\/([^/]+)\/attachments\/uploads$/,
      handler: async (context, match) => {
        scope(context);
        const input = attachmentInputSchema.parse(await readJson(context.request));
        const { user, projectId, slug } = scope(context);
        const found = page(projectId, match![1]!);
        json(context.response, 201, app.attachmentStore.begin(slug, projectId, found.id, user.id, input));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/attachment-uploads\/([^/]+)$/,
      handler: (context, match) => {
        const { user, projectId, slug } = scope(context);
        const upload = app.attachmentStore.status(slug, projectId, match![1]!, user.id);
        page(projectId, upload.pageId);
        json(context.response, 200, upload);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/attachment-uploads\/([^/]+)\/chunks$/,
      handler: async (context, match) => {
        scope(context);
        const input = chunkSchema.parse(await readJson(context.request));
        const data = Buffer.from(input.data, "base64");
        if (data.toString("base64") !== input.data)
          throw new HttpError(
            400,
            "Chunk data must be canonical base64, without a data URL prefix or whitespace.",
          );
        const { user, projectId, slug } = scope(context);
        const id = match![1]!;
        page(projectId, app.attachmentStore.status(slug, projectId, id, user.id).pageId);
        json(
          context.response,
          200,
          app.attachmentStore.chunk(slug, projectId, id, user.id, input.offset, data),
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/attachment-uploads\/([^/]+)\/complete$/,
      handler: async (context, match) => {
        const { user, projectId, slug } = scope(context);
        const id = match![1]!;
        const upload = app.attachmentStore.status(slug, projectId, id, user.id);
        page(projectId, upload.pageId);
        const result = await app.attachmentStore.complete(slug, projectId, id, user.id, () => {
          scope(context);
          page(projectId, upload.pageId);
          if (context.agent) {
            const secret = context.request.headers.authorization?.trim().slice(7).trim() ?? "";
            const live = agentForToken(app.database, secret);
            if (live?.scope !== "write")
              throw new HttpError(403, "The agent credential no longer permits this upload.");
          }
        });
        if (result.created) {
          const found = page(projectId, upload.pageId);
          app.audit(context, {
            projectId,
            entityType: "page",
            entityId: found.id,
            entityTitle: found.title,
            action: "updated",
            changes: [{ field: "attachment", from: null, to: result.upload.attachment!.filename }],
          });
          app.broadcast(projectId, "work", requestClientId(context.request));
        }
        json(context.response, 200, result.upload);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/attachment-uploads\/([^/]+)\/cancel$/,
      handler: (context, match) => {
        const { user, slug } = scope(context);
        app.attachmentStore.cancel(slug, match![1]!, user.id);
        json(context.response, 200, { ok: true });
      },
    },
    ...(["GET", "HEAD"] as const).map(
      (method): Route => ({
        method,
        pattern: /^\/api\/attachments\/([^/]+)$/,
        handler: (context, match) => {
          const { projectId, slug } = scope(context);
          const file = app.attachmentStore.file(slug, projectId, match![1]!);
          page(projectId, file.attachment.pageId);
          sendAttachment(
            context.request,
            context.response,
            file.path,
            file.attachment,
            context.url.searchParams.get("download") === "1",
          );
        },
      }),
    ),
  ];
}
