import {
  ATTACHMENT_IMAGE_LIMIT,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_VIDEO_LIMIT,
  type AttachmentMediaType,
  type AttachmentUpload,
  type PageAttachment,
} from "../../shared/attachments";
import { ApiError } from "./client";

export type UploadProgress = { phase: "Preparing" | "Uploading" | "Checking"; percent: number };
export type AttachmentSender = <T>(path: string, body: unknown) => Promise<T>;

const extensions: Record<string, AttachmentMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
};

function mediaType(file: File): AttachmentMediaType {
  const type =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : extensions[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (!ATTACHMENT_MEDIA_TYPES.includes(type as AttachmentMediaType)) {
    throw new ApiError("Choose a PNG, JPEG, WebP, GIF, or MP4 file.", 415);
  }
  const limit = type === "video/mp4" ? ATTACHMENT_VIDEO_LIMIT : ATTACHMENT_IMAGE_LIMIT;
  if (file.size === 0) throw new ApiError("This file is empty.", 400);
  if (file.size > limit)
    throw new ApiError(
      `${type === "video/mp4" ? "Videos" : "Images"} must be ${limit / 1_000_000} MB or smaller.`,
      413,
    );
  return type as AttachmentMediaType;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error("Uploads need a secure connection. Open Grimoire over HTTPS.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key includes immutable metadata, so retries resume but renamed files remain distinct. */
export async function uploadAttachment(
  pageId: string,
  file: File,
  signal: AbortSignal,
  progress: (value: UploadProgress) => void,
  send: AttachmentSender,
  demoProject?: string | null,
): Promise<PageAttachment> {
  signal.throwIfAborted();
  const type = mediaType(file);
  progress({ phase: "Preparing", percent: 0 });
  const sha256 = await digest(await file.arrayBuffer());
  signal.throwIfAborted();
  const key = await digest(new TextEncoder().encode(`${file.name}\n${type}\n${sha256}`).buffer);
  signal.throwIfAborted();
  const input = { filename: file.name, mediaType: type, size: file.size, sha256, key };
  if (demoProject !== undefined) {
    const { addDemoAttachment } = await import("../demo/attachments");
    signal.throwIfAborted();
    return addDemoAttachment(demoProject, pageId, file, input);
  }
  let upload = await send<AttachmentUpload>(
    `/api/pages/${encodeURIComponent(pageId)}/attachments/uploads`,
    input,
  );
  while (upload.state !== "complete" && upload.offset < file.size) {
    signal.throwIfAborted();
    progress({ phase: "Uploading", percent: Math.floor((upload.offset / file.size) * 100) });
    const bytes = new Uint8Array(
      await file.slice(upload.offset, upload.offset + upload.chunkLimit).arrayBuffer(),
    );
    // Chunks are bounded; spreading the entire chunk exceeds JavaScript's argument limit.
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    signal.throwIfAborted();
    upload = await send<AttachmentUpload>(`/api/attachment-uploads/${upload.id}/chunks`, {
      offset: upload.offset,
      data: btoa(binary),
    });
  }
  if (upload.state !== "complete") {
    signal.throwIfAborted();
    progress({ phase: "Checking", percent: 100 });
    upload = await send<AttachmentUpload>(`/api/attachment-uploads/${upload.id}/complete`, {});
  }
  if (!upload.attachment) throw new Error("The upload did not finish. Try again.");
  return upload.attachment;
}
