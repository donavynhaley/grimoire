import { HttpError, json } from "../http";
import { getBoard } from "../repository";
import { searchSchema } from "../schemas";
import { searchProject } from "../search";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

export function boardRoutes(app: AppContext): Route[] {
  const { database, pageStore, chapterStore, ideaStore } = app;
  return [
    {
      method: "GET",
      pattern: "/api/board",
      handler: (context) => {
        const user = requireUser(context);
        const board = getBoard(database, pageStore, chapterStore, user, app.requireProject(context, user));
        if (!board) throw new HttpError(404, "Board not found");
        json(context.response, 200, {
          ...board,
          // The project list exists for the switcher, and a token cannot switch. Sending the
          // issuer's other projects to a credential pinned to one of them would name things
          // the credential has no business knowing exist.
          projects: context.agent
            ? board.projects.filter((candidate) => candidate.id === board.project.id)
            : board.projects,
          currentUser: app.withAvatar(board.currentUser),
          members: board.members.map(app.withAvatar),
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/search",
      handler: (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const input = searchSchema.parse(Object.fromEntries(context.url.searchParams));
        json(
          context.response,
          200,
          searchProject(
            database,
            pageStore,
            chapterStore,
            ideaStore,
            projectId,
            input.q,
            input.limit,
            input.offset,
            input.scope,
          ),
        );
      },
    },
  ];
}
