import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MarkdownPageStore } from "../../server/markdown-pages";
import { bootstrap, ownerAccount, type startTestServer } from "../server/test-server";

const run = promisify(execFile);

type Server = Awaited<ReturnType<typeof startTestServer>>;

/** The project every importer suite lands its pages in. */
export const importTargetSlug = "kanban";

/**
 * A project for an import to land in: bootstrapped owner, optional categories, and one page
 * that predates the import - so every suite proves imported positions append rather than
 * collide.
 */
export async function provisionImportTarget(server: Server, categoryNames: string[] = []): Promise<string> {
  await bootstrap(server);
  const created = await server.request<{ project: { id: string } }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Kanban" }),
  });
  const projectId = created.body.project.id;
  const on = { headers: { "x-grimoire-project": projectId } };
  for (const name of categoryNames) {
    await server.request("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name, color: "#8bb9c9" }),
      ...on,
    });
  }
  await server.request("/api/pages", {
    method: "POST",
    body: JSON.stringify({ title: "Predates the import", status: "backlog" }),
    ...on,
  });
  return projectId;
}

/** Runs an ops importer the way a person does: node, the export, the data mounts, the flags. */
export async function runOpsImporter(
  script: string,
  server: Server,
  sourcePath: string,
  extra: string[] = [],
) {
  return run(process.execPath, [
    script,
    sourcePath,
    server.pagesDirectory,
    server.databasePath,
    "--project",
    importTargetSlug,
    "--as",
    ownerAccount.email,
    ...extra,
  ]);
}

/** What an import actually put on disk, read back through the real store. */
export function importedPages(server: Server) {
  return new MarkdownPageStore(server.pagesDirectory)
    .list(importTargetSlug)
    .filter((page) => page.title !== "Predates the import");
}
