import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirectory } from "./markdown-files";
import type { AppContext } from "./routes/context";

/** Collect only removed local media, after a successful save and a project-wide reference check. */
export function removeUnreferencedNoteMedia(
  app: AppContext,
  projectId: string,
  slug: string,
  before: string,
  after: string,
): void {
  if (before === after) return;
  const ids = new Set(Array.from(before.matchAll(/\/api\/attachments\/([a-f0-9]{64})\b/g), (m) => m[1]!));
  const contains = (body: string, value: string): boolean =>
    body.includes(value) || body.includes(encodeURIComponent(value));
  const images = new Set(app.imageStore.names(slug).filter((name) => contains(before, name)));
  for (const value of [...ids, ...images]) {
    if (contains(after, value)) {
      ids.delete(value);
      images.delete(value);
    }
  }
  if (!ids.size && !images.size) return;
  // Markdown includes archived pages, promoted ideas, and chapter notes. Conservatively
  // count literal references too, so code samples and copied links never lose their bytes.
  const documents: string[] = [];
  const read = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["attachments", "images"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) read(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) documents.push(readFileSync(path, "utf8"));
    }
  };
  read(projectDirectory(app.pageStore.rootDirectory, slug));
  for (const row of app.database
    .prepare("SELECT body FROM page_discussion WHERE project_id = ?")
    .all(projectId))
    documents.push(String(row.body));
  for (const id of ids) {
    if (!documents.some((body) => body.includes(id))) app.attachmentStore.remove(slug, id);
  }
  for (const name of images) {
    if (!documents.some((body) => contains(body, name))) app.imageStore.remove(slug, name);
  }
}
