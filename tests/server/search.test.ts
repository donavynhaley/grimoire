import { describe, expect, it } from "vitest";
import type { Card, Idea, SearchResults } from "../../shared/types";
import { bootstrap, startTestServer } from "./test-server";

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function addCard(server: Server, input: Record<string, unknown>, description?: string) {
  const created = await server.request<{ card: Card }>("/api/cards", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (description) {
    await server.request(`/api/cards/${created.body.card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
  }
  return created.body.card;
}

async function addIdea(server: Server, title: string, state?: string) {
  const created = await server.request<{ idea: Idea }>("/api/ideas", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (state) {
    await server.request(`/api/ideas/${created.body.idea.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    });
  }
  return created.body.idea;
}

function search(server: Server, query: string) {
  return server.request<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`);
}

describe("project search", () => {
  it("finds matches the board cannot draw: backlog, ideas, and archived cards", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    await addCard(server, { title: "Reagent rarity colours", status: "ready" });
    await addCard(server, { title: "Weather system affects reagent potency", status: "backlog" });
    await addCard(server, { title: "First playable brewing loop", status: "done" }, "Three reagents in, one potion out.");
    await addIdea(server, "Seasonal reagents that appear one week a year", "shortlist");
    const archived = await addCard(server, { title: "Reagent shelf prototype", status: "backlog" });
    await server.request(`/api/cards/${archived.id}`, { method: "DELETE" });

    const { body } = await search(server, "reagent");

    expect(body.total).toBe(5);
    const groups = body.hits.map((hit) => hit.group);
    expect(groups).toContain("active");
    expect(groups).toContain("backlog");
    expect(groups).toContain("ideas");
    expect(groups).toContain("done");
    expect(groups).toContain("archived");
    // Groups arrive in reading order, so the overlay never has to sort them itself.
    expect(groups).toEqual([...groups].sort((left, right) => order(left) - order(right)));
  });

  it("says where each result lives, as a reader would name it", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await addCard(server, { title: "Moonlight shader", status: "in_progress", category: "vfx" });
    await addCard(server, { title: "Moonlight ambience", status: "backlog" });
    await addIdea(server, "Moonlight changes reagent potency", "parked");

    const { body } = await search(server, "moonlight");

    expect(body.hits.map((hit) => hit.where)).toEqual(["In progress", "Backlog", "Parked"]);
    expect(body.hits[0].category).toBe("VFX");
    expect(body.hits[0].categoryColor).toBe("#d284d3");
  });

  it("matches note bodies and returns a plain-text window around the match", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await addCard(
      server,
      { title: "Potion workbench", status: "ready" },
      "## Acceptance\n\n- Failed combinations produce **sludge**\n- Results can be collected",
    );

    const { body } = await search(server, "sludge");

    expect(body.total).toBe(1);
    expect(body.hits[0].snippet).toContain("Failed combinations produce sludge");
    expect(body.hits[0].snippet).not.toContain("**");
    expect(body.hits[0].snippet).not.toContain("##");
  });

  it("ranks a title match above a mention buried in notes", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await addCard(server, { title: "Cellar storage", status: "backlog" }, "Holds the cauldron overflow.");
    await addCard(server, { title: "Cauldron wear states", status: "backlog" });

    const { body } = await search(server, "cauldron");

    expect(body.hits.map((hit) => hit.title)).toEqual(["Cauldron wear states", "Cellar storage"]);
  });

  it("leaves promoted ideas to their generated card instead of returning both", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const idea = await addIdea(server, "Rival shop across the square");
    await server.request(`/api/ideas/${idea.id}/promote`, { method: "POST" });

    const { body } = await search(server, "rival shop");

    expect(body.total).toBe(1);
    expect(body.hits[0].kind).toBe("card");
    expect(body.hits[0].group).toBe("backlog");
  });

  it("stops listing a card as archived once it has been restored", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const card = await addCard(server, { title: "Herb drying rack", status: "backlog" });
    await server.request(`/api/cards/${card.id}`, { method: "DELETE" });

    const archived = await search(server, "drying rack");
    expect(archived.body.hits.map((hit) => hit.group)).toEqual(["archived"]);

    // Search is the only route back to an archived card, so the round trip has to close.
    const restored = await server.request(`/api/cards/${card.id}/restore`, { method: "POST" });
    expect(restored.response.status).toBe(200);

    const after = await search(server, "drying rack");
    expect(after.body.total).toBe(1);
    expect(after.body.hits[0].group).toBe("backlog");
    expect(after.body.hits[0].where).toBe("Backlog");
  });

  it("answers an unmatched query with nothing rather than everything", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    await addCard(server, { title: "Herb drying rack", status: "backlog" });

    const { body } = await search(server, "submarine");

    expect(body).toEqual({ query: "submarine", total: 0, hits: [] });
  });

  it("requires a query and a signed-in reader", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    const blank = await server.fetchRaw("/api/search?q=%20%20");
    expect(blank.status).toBe(400);

    const anonymous = await fetch(`${server.baseUrl}/api/search?q=reagent`);
    expect(anonymous.status).toBe(401);
  });
});

function order(group: string): number {
  return ["active", "backlog", "ideas", "done", "archived"].indexOf(group);
}
