import type { PageAttachment } from "./attachments";

/** Markdown keeps media positioned among the words; the title identifies playable video. */
export function attachmentEmbed(attachment: PageAttachment): string {
  const label = attachment.filename.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
  const source = attachment.reference.replace(/[()\s<>]/g, encodeURIComponent);
  return `![${label}](${source} "${attachment.mediaType}")`;
}
