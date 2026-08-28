import { HttpError, json, readRaw, sendFile } from "../http";
import { IMAGE_SIZE_LIMIT, sniffImageType } from "../project-images";
import { projectSlug } from "../repository";
import { requireUser, type AppContext } from "./context";
import type { Route } from "./route";

/** The binary surfaces: profile pictures served by user id, note images by project. */
export function fileRoutes(app: AppContext): Route[] {
  const { database, avatarStore, imageStore } = app;
  return [
    {
      method: "GET",
      pattern: /^\/api\/avatars\/([^/]+)$/,
      handler: (context, match) => {
        requireUser(context);
        const userId = match![1]!;
        if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(404, "Profile picture not found");
        const avatar = avatarStore.get(userId);
        if (!avatar) throw new HttpError(404, "Profile picture not found");
        context.response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        sendFile(context.response, avatar.path, avatar.contentType);
      },
    },
    {
      method: "POST",
      pattern: "/api/images",
      handler: async (context) => {
        const user = requireUser(context);
        const slug = projectSlug(database, app.requireProject(context, user));
        if (!slug) throw new HttpError(404, "Board not found");
        const data = await readRaw(context.request, IMAGE_SIZE_LIMIT);
        const imageType = sniffImageType(data);
        if (!imageType) throw new HttpError(400, "Notes images must be a PNG, JPEG, WebP, or GIF image");
        const name = imageStore.save(slug, data, imageType);
        json(context.response, 201, { name });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/images\/([^/]+)$/,
      handler: (context, match) => {
        const user = requireUser(context);
        const slug = projectSlug(database, app.requireProject(context, user));
        let imageName: string;
        try {
          imageName = decodeURIComponent(match![1]!);
        } catch {
          throw new HttpError(404, "Image not found");
        }
        const image = slug ? imageStore.get(slug, imageName) : null;
        if (!image) throw new HttpError(404, "Image not found");
        context.response.setHeader("X-Content-Type-Options", "nosniff");
        context.response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        sendFile(context.response, image.path, image.contentType);
      },
    },
  ];
}
