import { describe, expect, it } from "vitest";
import type { Workspace } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

async function prepare(server: Awaited<ReturnType<typeof startTestServer>>) {
  await bootstrap(server);
  const workspace = (await server.request<Workspace>("/api/workspace")).body;
  const outcome = await server.request<{ outcome: { id: string } }>("/api/outcomes", {
    method: "POST",
    body: JSON.stringify({
      title: "The elemental source is readable in Wizard Sight",
      description: "A complete art and integration target for the vertical slice.",
      definitionOfPlayable: "The source appears mundane normally and meaningful in Sight.",
      ownerId: workspace.currentUser.id,
      milestoneId: workspace.milestones[0].id,
    }),
  });
  return { workspace, outcomeId: outcome.body.outcome.id };
}

describe("production workflows", () => {
  it("moves an asset through an owned handoff pipeline", async () => {
    const server = await startTestServer();
    const { workspace, outcomeId } = await prepare(server);

    const created = await server.request<{
      asset: { id: string; name: string; stages: Array<{ id: string; label: string; status: string }> };
    }>("/api/assets", {
      method: "POST",
      body: JSON.stringify({
        name: "Elemental source prop",
        type: "prop",
        outcomeId,
        ownerId: workspace.currentUser.id,
        notes: "Use the tower's worn material language.",
        stageLabels: ["model", "texture", "godot import", "in-game review"],
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.asset.stages.map((stage) => stage.status)).toEqual([
      "ready",
      "waiting",
      "waiting",
      "waiting",
    ]);

    const first = created.body.asset.stages[0];
    const completed = await server.request<{
      stage: { status: string; handoffNote: string };
      nextStage: { label: string; status: string };
    }>(`/api/asset-stages/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        handoffNote: "Source blend and exported GLB are ready for materials.",
      }),
    });
    expect(completed.response.status).toBe(200);
    expect(completed.body.stage.handoffNote).toContain("exported GLB");
    expect(completed.body.nextStage).toMatchObject({ label: "texture", status: "ready" });
  });

  it("records builds and turns playtest evidence into an outcome decision", async () => {
    const server = await startTestServer();
    const { outcomeId } = await prepare(server);

    const build = await server.request<{ build: { id: string; name: string } }>("/api/builds", {
      method: "POST",
      body: JSON.stringify({
        name: "sight-slice-001",
        summary: "First complete observation and element movement loop.",
        knownIssues: "The source highlight is too subtle in daylight.",
      }),
    });
    expect(build.response.status).toBe(201);

    const playtest = await server.request<{ playtest: { decision: string } }>("/api/playtests", {
      method: "POST",
      body: JSON.stringify({
        title: "Internal Sight discovery review",
        outcomeId,
        buildId: build.body.build.id,
        observations: "The discovery is understandable, but switching modes lacks contrast.",
        decision: "revise",
      }),
    });
    expect(playtest.response.status).toBe(201);
    expect(playtest.body.playtest.decision).toBe("revise");

    const updated = (await server.request<Workspace>("/api/workspace")).body;
    expect(updated.outcomes.find((outcome) => outcome.id === outcomeId)?.status).toBe("revise");
    expect(updated.builds[0].name).toBe("sight-slice-001");
    expect(updated.playtests[0].observations).toContain("lacks contrast");
  });

  it("keeps contextual discussion and activity attached to project work", async () => {
    const server = await startTestServer();
    const { outcomeId } = await prepare(server);

    const comment = await server.request<{ comment: { body: string; authorName: string } }>("/api/comments", {
      method: "POST",
      body: JSON.stringify({
        entityType: "outcome",
        entityId: outcomeId,
        body: "The normal view needs to remain believable before the reveal.",
      }),
    });
    expect(comment.response.status).toBe(201);
    expect(comment.body.comment).toMatchObject({ authorName: "Donavyn" });

    const updated = (await server.request<Workspace>("/api/workspace")).body;
    expect(updated.comments[0].body).toContain("normal view");
    expect(updated.activity.some((entry) => entry.entityType === "comment")).toBe(true);
    expect(updated.activity.some((entry) => entry.entityType === "outcome")).toBe(true);
  });
});

