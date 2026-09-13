import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ATTACHMENT_CHUNK_LIMIT,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_VIDEO_LIMIT,
} from "./attachment-types.js";
import { type GrimoireClient, GrimoireError } from "./client.js";

const id = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("The upload ID returned by grimoire_begin_attachment.");
const pageId = z
  .uuid()
  .describe("The destination page ID from grimoire_read_page. This credential's project only.");

/** The protocol carries bytes, so the MCP host never needs access to a caller's filesystem. */
export function registerAttachmentTools(server: McpServer, client: GrimoireClient, writable: boolean): void {
  server.registerTool(
    "grimoire_list_attachments",
    {
      title: "List a page's attachments",
      description:
        "Read image and recording metadata, including private stable links. Open links while signed in to this project.",
      inputSchema: { pageId },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId }) => result(() => client.attachments(pageId)),
  );
  server.registerTool(
    "grimoire_attachment_status",
    {
      title: "Resume an attachment upload",
      description:
        "Read the durable byte offset of your upload, or its completed attachment. If expired, begin again using the original key and metadata.",
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result(() => client.attachmentStatus(id)),
  );
  if (!writable) return;
  server.registerTool(
    "grimoire_begin_attachment",
    {
      title: "Begin or resume attaching evidence",
      description:
        "Attach an image (PNG/JPEG/WebP/GIF, up to 10 MB) or an MP4 (H.264 with optional AAC, up to 100 MB, 10 minutes). Compute SHA-256 on the machine holding the file. Reuse the same key and metadata after any interruption: begin returns the existing offset or completed attachment. Upload base64 chunks next, then complete. Unfinished uploads expire after 24 hours; at most 8 per project. Notes are never changed. No local path is accepted.",
      inputSchema: {
        pageId,
        filename: z.string().min(1).max(200),
        mediaType: z.enum(ATTACHMENT_MEDIA_TYPES),
        size: z.number().int().positive().max(ATTACHMENT_VIDEO_LIMIT),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        key: z
          .string()
          .min(8)
          .max(100)
          .regex(/^[A-Za-z0-9_-]+$/)
          .describe("Stable retry key. Prefer the file's SHA-256; keep it unchanged for this page and file."),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ pageId, ...input }) => result(() => client.beginAttachment(pageId, input)),
  );
  server.registerTool(
    "grimoire_upload_attachment_chunk",
    {
      title: "Send attachment bytes",
      description:
        "Send up to 512000 decoded bytes as canonical base64, without a data URL prefix. offset is the byte position in the original local file. A repeated chunk must contain identical bytes; interrupted prefixes resume safely. Follow the returned offset. Rate limits apply: wait and retry the same chunk on 429. Use grimoire_attachment_status after a lost response.",
      inputSchema: {
        id,
        offset: z.number().int().nonnegative(),
        data: z
          .string()
          .min(4)
          .max(Math.ceil(ATTACHMENT_CHUNK_LIMIT / 3) * 4),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, offset, data }) => result(() => client.attachmentChunk(id, offset, data)),
  );
  server.registerTool(
    "grimoire_complete_attachment",
    {
      title: "Validate and attach uploaded evidence",
      description:
        "Verify size, SHA-256, and decodable media, then atomically attach to the page. Returns attachment ID, page ID, filename, media type, and private stable reference. Validation can take up to 75 seconds. Retry safely after a lost response. On validation failure, bytes stay private until cancelled or expired; no partial attachment is shown.",
      inputSchema: { id },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => result(() => client.completeAttachment(id)),
  );
  server.registerTool(
    "grimoire_cancel_attachment_upload",
    {
      title: "Discard an unfinished upload",
      description:
        "Remove only your unfinished upload and its bytes. Already attached evidence cannot be deleted by this tool. Repeating cancellation is safe.",
      inputSchema: { id },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => result(() => client.cancelAttachment(id)),
  );
}

async function result(
  action: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await action(), null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            error instanceof GrimoireError
              ? `HTTP ${error.status}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error),
        },
      ],
    };
  }
}
