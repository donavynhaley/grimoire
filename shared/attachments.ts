/** Byte limits are decimal, matching the limits shown to agents. */
export const ATTACHMENT_IMAGE_LIMIT = 10_000_000;
export const ATTACHMENT_VIDEO_LIMIT = 100_000_000;
export const ATTACHMENT_CHUNK_LIMIT = 512_000;
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
] as const;
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

export type PageAttachment = {
  id: string;
  pageId: string;
  filename: string;
  mediaType: AttachmentMediaType;
  size: number;
  sha256: string;
  createdAt: string;
  createdBy: string;
  /** An authenticated, project-qualified URL path, stable across retries. */
  reference: string;
};

export type AttachmentUploadInput = {
  filename: string;
  mediaType: AttachmentMediaType;
  size: number;
  sha256: string;
  key: string;
};

export type AttachmentUpload = {
  id: string;
  pageId: string;
  state: "uploading" | "complete";
  offset: number;
  size: number;
  chunkLimit: number;
  expiresAt: string | null;
  attachment: PageAttachment | null;
};
