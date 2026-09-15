import type { AttachmentUploadInput, PageAttachment } from "../../shared/attachments";
import { demoAttachmentSources } from "./mode";

const files = new Map<string, PageAttachment[]>();
const scope = (project: string | null, page: string) => `${project ?? "default"}/${page}`;

export function demoAttachments(project: string | null, page: string): PageAttachment[] {
  return [...(files.get(scope(project, page)) ?? [])];
}

/** Demo media stays in this tab's memory, never in localStorage or on the server. */
export function addDemoAttachment(
  project: string | null,
  pageId: string,
  file: File,
  input: AttachmentUploadInput,
): PageAttachment {
  const list = demoAttachments(project, pageId);
  const existing = list.find((item) => item.id === input.key);
  if (existing) return existing;
  const total = [...files.values()].flat().reduce((bytes, item) => bytes + item.size, 0);
  if (total + file.size > 100_000_000)
    throw new Error("The demo holds up to 100 MB of files. Reset the playground to free space.");
  const attachment: PageAttachment = {
    id: input.key,
    pageId,
    filename: input.filename,
    mediaType: input.mediaType,
    size: input.size,
    sha256: input.sha256,
    createdAt: new Date().toISOString(),
    createdBy: "demo",
    reference: URL.createObjectURL(file),
  };
  files.set(scope(project, pageId), [...list, attachment]);
  demoAttachmentSources.add(attachment.reference);
  return attachment;
}

export function clearDemoAttachments(): void {
  for (const list of files.values()) for (const file of list) URL.revokeObjectURL(file.reference);
  files.clear();
  demoAttachmentSources.clear();
}
