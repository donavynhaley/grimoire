import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { attachmentEmbed } from "../shared/attachment-embed";
import {
  ATTACHMENT_CHUNK_LIMIT,
  ATTACHMENT_IMAGE_LIMIT,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_TTL_MS,
  ATTACHMENT_VIDEO_LIMIT,
  type AttachmentUpload,
  type AttachmentUploadInput,
  type PageAttachment,
} from "../shared/attachments";
import { validateAttachmentMedia } from "./attachment-media";
import { HttpError } from "./http";
import { parseMarkdown, projectDirectory, serializeMarkdown, writeAtomic } from "./markdown-files";

export const attachmentInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\\p{Cc}\p{Cf}\uD800-\uDFFF]+$/u, "Use a filename without paths or control characters"),
    mediaType: z.enum(ATTACHMENT_MEDIA_TYPES),
    size: z.number().int().positive().max(ATTACHMENT_VIDEO_LIMIT),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    key: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
const recordSchema = attachmentInputSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  pageId: z.uuid(),
  createdAt: z.iso.datetime(),
  createdBy: z.uuid(),
});
type AttachmentRecord = z.infer<typeof recordSchema>;
const MAX_PENDING = 8;

/** A directory rename publishes bytes and their Markdown record together, without editing notes. */
export class PageAttachmentStore {
  private readonly completing = new Set<string>();
  constructor(readonly rootDirectory: string) {
    if (existsSync(rootDirectory)) {
      for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) this.cleanup(entry.name);
      }
    }
  }

  begin(
    slug: string,
    projectId: string,
    pageId: string,
    userId: string,
    input: AttachmentUploadInput,
  ): AttachmentUpload {
    if (input.mediaType !== "video/mp4" && input.size > ATTACHMENT_IMAGE_LIMIT)
      throw new HttpError(413, "Images are limited to 10 MB; MP4 recordings to 100 MB.");
    this.cleanup(slug);
    const id = createHash("sha256").update(`${pageId}\n${input.key}`).digest("hex");
    let existing = this.locate(slug, id);
    if (
      existing &&
      !existing.complete &&
      (!existsSync(join(existing.path, "attachment.md")) || !existsSync(join(existing.path, "content")))
    ) {
      // A crash during begin may leave only the directory or manifest. No acknowledged bytes
      // exist until both files do, so the same key can safely restart this incomplete begin.
      rmSync(existing.path, { recursive: true, force: true });
      existing = null;
    }
    if (existing) {
      const record = this.read(existing.path);
      this.requireOwner(record, userId);
      if (
        record.pageId !== pageId ||
        record.filename !== input.filename ||
        record.sha256 !== input.sha256 ||
        record.size !== input.size ||
        record.mediaType !== input.mediaType
      )
        throw new HttpError(
          409,
          "This retry key belongs to different file metadata. Reuse the original metadata or choose a new key.",
        );
      return this.status(slug, projectId, id, userId);
    }
    const pending = join(this.root(slug), ".uploads");
    mkdirSync(pending, { recursive: true });
    if (readdirSync(pending).length >= MAX_PENDING)
      throw new HttpError(
        429,
        "This project already has 8 unfinished uploads. Complete or cancel one before starting another.",
      );
    const path = join(pending, id);
    const record: AttachmentRecord = {
      ...input,
      id,
      pageId,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(path);
    try {
      this.write(path, record);
      writeAtomic(join(path, "content"), Buffer.alloc(0));
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
    return this.status(slug, projectId, id, userId);
  }

  status(slug: string, projectId: string, id: string, userId: string): AttachmentUpload {
    const found = this.locate(slug, id);
    if (!found)
      throw new HttpError(
        404,
        "Upload not found or expired. Begin again with the same key and file metadata.",
      );
    if (
      !found.complete &&
      (!existsSync(join(found.path, "attachment.md")) || !existsSync(join(found.path, "content")))
    )
      throw new HttpError(
        410,
        "Upload initialization was interrupted. Begin again with the same key and file metadata.",
      );
    const record = this.read(found.path);
    this.requireOwner(record, userId);
    if (!found.complete && Date.parse(record.createdAt) + ATTACHMENT_TTL_MS <= Date.now())
      throw new HttpError(410, "Upload expired. Begin again with the same key and file metadata.");
    return {
      id,
      pageId: record.pageId,
      state: found.complete ? "complete" : "uploading",
      offset: statSync(join(found.path, "content")).size,
      size: record.size,
      chunkLimit: ATTACHMENT_CHUNK_LIMIT,
      expiresAt: found.complete
        ? null
        : new Date(Date.parse(record.createdAt) + ATTACHMENT_TTL_MS).toISOString(),
      attachment: found.complete ? this.publicRecord(record, projectId) : null,
    };
  }

  chunk(
    slug: string,
    projectId: string,
    id: string,
    userId: string,
    offset: number,
    data: Buffer,
  ): AttachmentUpload {
    const status = this.status(slug, projectId, id, userId);
    if (status.state === "complete") return status;
    if (this.completing.has(`${slug}/${id}`))
      throw new HttpError(409, "Completion is in progress. Retry status shortly.");
    if (data.length === 0 || data.length > ATTACHMENT_CHUNK_LIMIT)
      throw new HttpError(413, "Chunks must contain 1 to 512000 decoded bytes.");
    if (offset > status.offset || offset + data.length > status.size)
      throw new HttpError(409, `Chunk does not fit. Resume at offset ${status.offset}.`);
    const path = join(this.root(slug), ".uploads", id, "content");
    const descriptor = openSync(path, "r+");
    try {
      const overlap = Math.min(data.length, status.offset - offset);
      const previous = Buffer.alloc(overlap);
      readSync(descriptor, previous, 0, overlap, offset);
      if (!previous.equals(data.subarray(0, overlap)))
        throw new HttpError(
          409,
          "Retry bytes differ from bytes already received. Check the local file or cancel this upload.",
        );
      // Actual file length is the durable offset. A crash partway through a write can resume
      // from that prefix, including when the caller repeats the entire unacknowledged chunk.
      let written = overlap;
      while (written < data.length)
        written += writeSync(descriptor, data, written, data.length - written, offset + written);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return this.status(slug, projectId, id, userId);
  }

  async complete(
    slug: string,
    projectId: string,
    id: string,
    userId: string,
    authorize: () => void,
  ): Promise<{ upload: AttachmentUpload; created: boolean }> {
    const status = this.status(slug, projectId, id, userId);
    if (status.state === "complete") return { upload: status, created: false };
    if (status.offset !== status.size)
      throw new HttpError(409, `Upload is incomplete. Resume at offset ${status.offset} of ${status.size}.`);
    const lock = `${slug}/${id}`;
    if (this.completing.has(lock))
      throw new HttpError(409, "Completion is in progress. Retry status shortly.");
    this.completing.add(lock);
    try {
      const path = join(this.root(slug), ".uploads", id);
      const record = this.read(path);
      // Hash in fixed buffers so validation never loads a 100 MB recording into the server heap.
      const hash = createHash("sha256");
      const fd = openSync(join(path, "content"), "r");
      try {
        const buffer = Buffer.alloc(ATTACHMENT_CHUNK_LIMIT);
        for (;;) {
          const length = readSync(fd, buffer);
          if (length === 0) break;
          hash.update(buffer.subarray(0, length));
        }
      } finally {
        closeSync(fd);
      }
      if (hash.digest("hex") !== record.sha256)
        throw new HttpError(
          422,
          "File checksum differs from the declared SHA-256. Cancel this upload and begin with the correct file.",
        );
      await validateAttachmentMedia(join(path, "content"), record.mediaType);
      // Validation yields. The page, membership, and delegated credential must still exist
      // when bytes become visible, not just when the request started.
      authorize();
      renameSync(path, join(this.root(slug), id));
      return { upload: this.status(slug, projectId, id, userId), created: true };
    } finally {
      this.completing.delete(lock);
    }
  }

  cancel(slug: string, id: string, userId: string): void {
    const found = this.locate(slug, id);
    if (!found) return;
    this.requireOwner(this.read(found.path), userId);
    if (found.complete)
      throw new HttpError(409, "This file is already attached. Cancel only removes unfinished uploads.");
    if (this.completing.has(`${slug}/${id}`))
      throw new HttpError(409, "Completion is in progress. Retry status shortly.");
    rmSync(join(this.root(slug), ".uploads", id), { recursive: true, force: true });
  }

  list(slug: string, projectId: string, pageId: string): PageAttachment[] {
    const root = this.root(slug);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((id) => /^[a-f0-9]{64}$/.test(id))
      .map((id) => this.read(join(root, id)))
      .filter((record) => record.pageId === pageId)
      .map((record) => this.publicRecord(record, projectId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  file(slug: string, projectId: string, id: string): { attachment: PageAttachment; path: string } {
    const found = this.locate(slug, id);
    if (!found?.complete) throw new HttpError(404, "Attachment not found");
    return {
      attachment: this.publicRecord(this.read(found.path), projectId),
      path: join(found.path, "content"),
    };
  }

  cleanup(slug: string): void {
    const pending = join(this.root(slug), ".uploads");
    if (!existsSync(pending)) return;
    for (const id of readdirSync(pending)) {
      if (!/^[a-f0-9]{64}$/.test(id) || this.completing.has(`${slug}/${id}`)) continue;
      const path = join(pending, id);
      // Directory mtime also covers a process dying before its manifest was committed.
      if (statSync(path).mtimeMs + ATTACHMENT_TTL_MS <= Date.now())
        rmSync(path, { recursive: true, force: true });
    }
  }

  private root(slug: string): string {
    return join(projectDirectory(this.rootDirectory, slug), "attachments");
  }
  private locate(slug: string, id: string): { path: string; complete: boolean } | null {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(404, "Attachment not found");
    const root = this.root(slug);
    if (existsSync(join(root, id))) return { path: join(root, id), complete: true };
    if (existsSync(join(root, ".uploads", id))) return { path: join(root, ".uploads", id), complete: false };
    return null;
  }
  private read(path: string): AttachmentRecord {
    return recordSchema.parse(parseMarkdown(readFileSync(join(path, "attachment.md"), "utf8")).metadata);
  }
  private write(path: string, record: AttachmentRecord): void {
    writeAtomic(join(path, "attachment.md"), serializeMarkdown(Object.entries(record), ""));
  }
  private requireOwner(record: AttachmentRecord, userId: string): void {
    if (record.createdBy !== userId) throw new HttpError(403, "Only the upload's owner can resume it.");
  }
  private publicRecord(record: AttachmentRecord, projectId: string): PageAttachment {
    const { key: _key, ...attachment } = record;
    const result = {
      ...attachment,
      reference: `/api/attachments/${record.id}?project=${encodeURIComponent(projectId)}`,
    };
    return { ...result, embed: attachmentEmbed(result) };
  }
}
