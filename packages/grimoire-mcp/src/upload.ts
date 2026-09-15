#!/usr/bin/env node
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  ATTACHMENT_IMAGE_LIMIT,
  ATTACHMENT_VIDEO_LIMIT,
  type AttachmentMediaType,
} from "./attachment-types.js";
import { GrimoireClient, GrimoireError } from "./client.js";

/** Run beside the local file; only byte chunks travel to the remote Grimoire instance. */
async function main(): Promise<void> {
  const [pageId, path] = process.argv.slice(2);
  const baseUrl = process.env.GRIMOIRE_URL;
  const token = process.env.GRIMOIRE_TOKEN;
  if (!pageId || !path || process.argv.length !== 4 || !baseUrl || !token)
    throw new Error(
      "Usage: grimoire-upload <page-id> <local-file> with GRIMOIRE_URL and GRIMOIRE_TOKEN set. Run on the machine holding the file.",
    );
  const types: Record<string, AttachmentMediaType> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
  };
  const mediaType = types[extname(path).toLowerCase()];
  if (!mediaType) throw new Error("Use a PNG, JPEG, WebP, GIF, or MP4 file.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > (mediaType === "video/mp4" ? ATTACHMENT_VIDEO_LIMIT : ATTACHMENT_IMAGE_LIMIT)
    )
      throw new Error("Expected a nonempty file: images up to 10 MB, MP4 recordings up to 100 MB.");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const client = new GrimoireClient({ baseUrl, token, projectId: process.env.GRIMOIRE_PROJECT });
    let upload = await retry(() =>
      client.beginAttachment(pageId, {
        filename: basename(path),
        mediaType,
        size: stat.size,
        sha256,
        key: sha256,
      }),
    );
    while (upload.state !== "complete" && upload.offset < upload.size) {
      const offset = upload.offset;
      const buffer = Buffer.alloc(Math.min(upload.chunkLimit, upload.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length)
        throw new Error(
          "The local file changed while uploading. Cancel this upload and try again with a stable copy.",
        );
      upload = await retry(() => client.attachmentChunk(upload.id, offset, buffer.toString("base64")));
      console.error(`${upload.offset}/${upload.size} bytes`);
    }
    if (upload.state !== "complete") upload = await retry(() => client.completeAttachment(upload.id));
    console.log(JSON.stringify(upload.attachment, null, 2));
  } finally {
    await file.close();
  }
}

async function retry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (
        !(error instanceof GrimoireError) ||
        (![0, 429, 502, 503, 504].includes(error.status) &&
          !(error.status === 409 && error.message.includes("Completion is in progress"))) ||
        attempt >= 12
      )
        throw error;
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      console.error(
        `Upload interrupted (${error.status}). Retrying in ${delay / 1000}s; rerunning this command also resumes safely.`,
      );
      await setTimeout(delay);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
