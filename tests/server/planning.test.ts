import { describe, expect, it } from "vitest";
import type { Workspace } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

async function workspace(server: Awaited<ReturnType<typeof startTestServer>>) {
  return (await server.request<Workspace>("/api/workspace")).body;
}

describe("planning workflows", () => {
  it("updates the game direction and milestone evidence", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const initial = await workspace(server);

    const direction = await server.request<{ project: Workspace["project"] }>("/api/project", {
      method: "PATCH",
      body: JSON.stringify({
        currentDirection: "Make the first magical case playable from beginning to end.",
        directionDetail: "Use Wizard Sight, rune work, and one consequential decision.",
        nonGoals: "No additional regions during this focus.",
      }),
    });
    expect(direction.response.status).toBe(200);
    expect(direction.body.project.currentDirection).toContain("first magical case");

    const conditionId = initial.milestones[0].conditions.find((condition) => !condition.complete)!.id;
    const condition = await server.request<{ condition: { complete: boolean } }>(
      `/api/milestone-conditions/${conditionId}`,
      { method: "PATCH", body: JSON.stringify({ complete: true }) },
    );
    expect(condition.response.status).toBe(200);
    expect(condition.body.condition.complete).toBe(true);
  });

  it("sorts an idea and deliberately promotes it into an outcome", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const initial = await workspace(server);
    const idea = initial.ideas[0];

    const sorted = await server.request<{ idea: { status: string; horizon: string } }>(
      `/api/ideas/${idea.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "considering", horizon: "next", notes: "Test this after Sight." }),
      },
    );
    expect(sorted.response.status).toBe(200);
    expect(sorted.body.idea).toMatchObject({ status: "considering", horizon: "next" });

    const promoted = await server.request<{
      idea: { status: string; promotedOutcomeId: string };
      outcome: { id: string; title: string; status: string };
    }>(`/api/ideas/${idea.id}/promote`, {
      method: "POST",
      body: JSON.stringify({
        title: "Awakened objects retain traces of their previous wizard",
        description: "The player can discover one memory by observing an awakened object.",
        definitionOfPlayable: "The tower door reveals a readable memory of Maren in Wizard Sight.",
      }),
    });
    expect(promoted.response.status).toBe(201);
    expect(promoted.body.idea.status).toBe("promoted");
    expect(promoted.body.outcome).toMatchObject({ status: "shaping" });
    expect(promoted.body.idea.promotedOutcomeId).toBe(promoted.body.outcome.id);
  });

  it("coordinates owned work and unlocks dependent handoffs", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const initial = await workspace(server);

    const outcome = await server.request<{ outcome: { id: string } }>("/api/outcomes", {
      method: "POST",
      body: JSON.stringify({
        title: "The first Sight discovery is playable",
        description: "Build one complete observation and manipulation loop.",
        definitionOfPlayable: "A player can solve it without developer explanation.",
        ownerId: initial.currentUser.id,
        milestoneId: initial.milestones[0].id,
        pillarId: initial.pillars[1].id,
      }),
    });
    expect(outcome.response.status).toBe(201);

    const model = await server.request<{ workItem: { id: string } }>("/api/work", {
      method: "POST",
      body: JSON.stringify({
        outcomeId: outcome.body.outcome.id,
        title: "Model the elemental source",
        discipline: "3d art",
        ownerId: initial.currentUser.id,
      }),
    });
    const integrate = await server.request<{ workItem: { id: string; status: string } }>("/api/work", {
      method: "POST",
      body: JSON.stringify({
        outcomeId: outcome.body.outcome.id,
        title: "Integrate the elemental source",
        discipline: "integration",
        ownerId: initial.currentUser.id,
        dependencyIds: [model.body.workItem.id],
      }),
    });
    expect(integrate.body.workItem.status).toBe("blocked");

    const completed = await server.request<{ workItem: { status: string } }>(
      `/api/work/${model.body.workItem.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
    );
    expect(completed.body.workItem.status).toBe("done");

    const updated = await workspace(server);
    expect(updated.workItems.find((item) => item.id === integrate.body.workItem.id)?.status).toBe("ready");

    const activated = await server.request<{ outcome: { status: string } }>(
      `/api/outcomes/${outcome.body.outcome.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "active" }) },
    );
    expect(activated.body.outcome.status).toBe("active");
  });
});
