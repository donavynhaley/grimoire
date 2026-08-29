import { githubApiFetcher, listOpenPullRequests, verifyRepoAccess } from "../github";
import { HttpError, json, readJson, requestClientId } from "../http";
import { projectGithubConfig } from "../repository/github";
import { type AppContext, requireUser } from "./context";
import type { Route } from "./route";

const recapPattern = /^\/api\/chapters\/([^/]+)\/recap$/;

/** The GitHub connection and the chapter recaps that go out over Discord. */
export function githubRoutes(app: AppContext): Route[] {
  const { database, options } = app;
  return [
    {
      method: "GET",
      pattern: "/api/github/pulls",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        const config = projectGithubConfig(database, projectId);
        const pulls = await listOpenPullRequests(
          options.githubFetcher ?? githubApiFetcher,
          config.repo,
          config.token,
        );
        json(context.response, 200, { pulls });
      },
    },
    {
      method: "GET",
      pattern: recapPattern,
      handler: (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        app.requireChaptersEnabled(projectId);
        const recap = app.recapFor(projectId, match![1]!);
        if (!recap) throw new HttpError(404, "Chapter not found");
        json(context.response, 200, { recap });
      },
    },
    {
      method: "POST",
      pattern: recapPattern,
      handler: async (context, match) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(context, user, "Only the owner can post a recap");
        app.requireChaptersEnabled(projectId);
        await readJson(context.request);
        const result = await app.sendRecap(projectId, match![1]!);
        if (result === "not_found") throw new HttpError(404, "Chapter not found");
        if (result === "no_webhook")
          throw new HttpError(400, "This project has no Discord webhook to post to");
        json(context.response, 200, result);
      },
    },
    {
      method: "POST",
      pattern: "/api/github/verify",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProjectOwner(
          context,
          user,
          "Only the owner can check the GitHub connection",
        );
        await readJson(context.request);
        const config = projectGithubConfig(database, projectId);
        const verdict = await verifyRepoAccess(
          options.githubFetcher ?? githubApiFetcher,
          config.repo,
          config.token,
        );
        json(context.response, 200, verdict);
      },
    },
    {
      method: "POST",
      pattern: "/api/github/refresh",
      handler: async (context) => {
        const user = requireUser(context);
        const projectId = app.requireProject(context, user);
        await readJson(context.request);
        await app.runGithubSync(projectId);
        json(context.response, 200, { ok: true });
        app.broadcast(projectId, "work", requestClientId(context.request));
      },
    },
  ];
}
