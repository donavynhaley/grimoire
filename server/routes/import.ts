import type { ImportSource } from "../../shared/types";
import { HttpError, json, readRaw, requestClientId } from "../http";
import { applyBoardImport, type ImportMappings, importBlockers, planBoardImport } from "../import-board";
import { categoriesForProject } from "../repository/categories";
import { projectById } from "../repository/projects";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

/**
 * A whole exported board, uploaded raw the way images are, with generous room: refusing a
 * real Trello export over size would tell someone their board is too big to leave Trello.
 */
const IMPORT_SIZE_LIMIT = 40_000_000;

/*
 * One route does both halves of the settings screen's import: without `apply` it plans and
 * writes nothing, with `apply=1` it re-plans against the file it was just handed and writes
 * only if nothing is unmapped and nothing failed. Stateless on purpose - the file travels
 * with every call, so there is no upload to store, expire, or leak between projects.
 *
 * Owner-only: an import reshapes a whole board at once, which is the "restructure" half of
 * the agent rule applied to people. And it is deliberately absent from the agent allow list:
 * bulk creation with historical timestamps is exactly the write a person should press.
 */
export function importRoutes(app: AppContext): Route[] {
  const { database, pageStore } = app;
  return [
    {
      method: "POST",
      pattern: "/api/import",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(
          context,
          user,
          "Only the owner imports another tool's board",
        );
        const params = context.url.searchParams;
        const source = params.get("source");
        if (source !== "trello" && source !== "focalboard") {
          throw new HttpError(400, 'source must be "trello" or "focalboard"');
        }
        const mappings: ImportMappings = {
          lists: pairs(params.getAll("list")),
          options: pairs(params.getAll("option")),
          status: params.get("status"),
          board: params.get("board"),
        };
        const data = await readRaw(context.request, IMPORT_SIZE_LIMIT);
        if (data.length === 0) throw new HttpError(400, "Upload the export file as the request body");

        const project = projectById(database, projectId);
        if (!project) throw new HttpError(404, "Project not found");
        const { plan, pages } = planBoardImport({
          source: source as ImportSource,
          data,
          mappings,
          pageStore,
          projectSlug: String(project.slug),
          categories: categoriesForProject(database, projectId),
          createdBy: user.email,
        });

        if (params.get("apply") !== "1") {
          json(context.response, 200, { plan, applied: null });
          return;
        }
        if (importBlockers(plan)) {
          // 422 rather than 400: the request was well-formed, the export just still has
          // questions only a person can answer. The plan says which.
          json(context.response, 422, { plan, applied: null });
          return;
        }
        const applied = applyBoardImport(pageStore, String(project.slug), pages);
        // One event, not one per page: five hundred "created" rows would bury the log's
        // real edits under the import that day, and the one fact a reader scans for is
        // that the import happened.
        app.audit(context, {
          projectId,
          entityType: "project",
          entityId: projectId,
          entityTitle: String(project.name),
          action: "updated",
          changes: [
            {
              field: "import",
              from: null,
              to: `${applied} page${applied === 1 ? "" : "s"} from ${source === "trello" ? "Trello" : "Focalboard"}`,
            },
          ],
        });
        json(context.response, 200, { plan, applied });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}

/** Repeated "Name=Column" query values, exactly the shape the CLI flags take. */
function pairs(values: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator < 1) throw new HttpError(400, `Mappings take "Name=Column", got "${value}"`);
    record[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
  }
  return record;
}
