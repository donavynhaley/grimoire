import { describe, expect, it } from "vitest";
import type { Page, ProjectCategory, ProjectField } from "../../shared/types";
import {
  buildFacets,
  countSelected,
  decodeFacets,
  encodeFacets,
  type FacetContext,
  facetPredicate,
  toggleFacet,
  UNSET,
} from "../../src/lib/page-facets";

const NOW = new Date("2026-08-22T12:00:00.000Z");

const categories: ProjectCategory[] = [
  { slug: "design", name: "Design", color: "#d6bc78", position: 0 },
  { slug: "code", name: "Code", color: "#8bb9c9", position: 1 },
  { slug: "audio", name: "Audio", color: "#b8d99b", position: 2 },
];

const fields: ProjectField[] = [
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: ["Critical", "High", "Low"],
    position: 0,
    showOnTile: true,
  },
  { key: "needs-art", label: "Needs art", type: "checkbox", options: [], position: 1, showOnTile: false },
];

function page(over: Partial<Page> & { id: string }): Page {
  return {
    title: over.id,
    description: "",
    category: null,
    chapter: null,
    fields: {},
    blockedBy: [],
    status: "ready",
    position: 0,
    assigneeId: null,
    assigneeName: null,
    createdById: "maren",
    createdByName: "Maren Voss",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    estimate: null,
    github: null,
    githubStatus: null,
    ...over,
  } as Page;
}

const LAST_WEEK = new Date("2026-08-18T09:00:00.000Z").toISOString();

const pages: Page[] = [
  page({ id: "a", category: "code", status: "ready", fields: { priority: "Critical" }, estimate: 5 }),
  page({
    id: "b",
    category: "code",
    status: "in_progress",
    fields: { priority: "High", "needs-art": true },
    estimate: 8,
    blockedBy: ["a"],
    github: { kind: "pr", number: 12 },
    githubStatus: {
      state: "open",
      prNumber: 12,
      prTitle: "Rework",
      prUrl: "https://example.com/12",
      checkedAt: NOW.toISOString(),
    },
  }),
  page({ id: "c", category: "audio", status: "ready", fields: { priority: "High" }, updatedAt: LAST_WEEK }),
  page({ id: "d", category: null, status: "done", createdById: "priya", createdByName: "Priya Raghavan" }),
];

const context: FacetContext = { categories, fields, estimatesEnabled: true, now: NOW };
const facetsOf = (selection = {}) => buildFacets(pages, selection, context);
const find = (key: string, selection = {}) => facetsOf(selection).find((facet) => facet.key === key);
const idsOf = (key: string, selection = {}) => find(key, selection)?.values.map((value) => value.id);
const keep = (selection: Record<string, string[]>) =>
  pages.filter(facetPredicate(selection, context)).map((p) => p.id);

describe("what the board can be filtered by", () => {
  it("offers the project's own vocabulary before the properties every project shares", () => {
    expect(facetsOf().map((facet) => facet.key)).toEqual([
      "category",
      "status",
      "field:priority",
      "field:needs-art",
      "estimate",
      "blocked",
      "github",
      "createdBy",
      "updated",
    ]);
  });

  it("leaves out assignee and chapter, which have controls of their own in the same bar", () => {
    const keys = facetsOf().map((facet) => facet.key);
    expect(keys).not.toContain("assignee");
    expect(keys).not.toContain("chapter");
  });

  it("offers only the values the board actually holds", () => {
    // Design is a category of this project that nothing uses, so it is not offered.
    expect(idsOf("category")).toEqual(["code", "audio", UNSET]);
    expect(idsOf("status")).toEqual(["ready", "in_progress", "done"]);
  });

  it("keeps the project's order for its own values and puts the unfilled answer last", () => {
    expect(idsOf("field:priority")).toEqual(["Critical", "High", UNSET]);
    expect(find("field:priority")?.values.at(-1)?.label).toBe("not set");
  });

  it("reads a checkbox the way the page itself shows it", () => {
    expect(idsOf("field:needs-art")).toEqual(["yes", UNSET]);
  });

  it("counts numbers as numbers, so 8 follows 5 rather than sorting as text", () => {
    expect(idsOf("estimate")).toEqual(["5", "8", UNSET]);
  });

  it("drops a property every page answers the same way, since ticking it narrows nothing", () => {
    const withoutEstimates = buildFacets(pages, {}, { ...context, estimatesEnabled: false });
    expect(withoutEstimates.map((facet) => facet.key)).not.toContain("estimate");

    // With nothing linked, "not linked" is the only answer there is and the section is noise.
    const unlinked = pages.filter((candidate) => !candidate.github);
    expect(buildFacets(unlinked, {}, context).map((facet) => facet.key)).not.toContain("github");
    expect(buildFacets(pages, {}, context).map((facet) => facet.key)).toContain("github");
  });

  it("keeps a section that is being filtered on, however narrow the board gets", () => {
    // Every remaining page is in Code, so the section would otherwise vanish - taking the only
    // way to undo the tick with it.
    const selection = { category: ["code"], "field:priority": ["Critical"] };
    expect(buildFacets(pages, selection, context).map((facet) => facet.key)).toContain("category");
  });

  it("names whoever wrote the page, which only the pages themselves carry", () => {
    expect(
      find("createdBy")
        ?.values.map((value) => value.label)
        .sort(),
    ).toEqual(["Maren Voss", "Priya Raghavan"]);
  });
});

describe("filtering", () => {
  it("treats values inside one property as alternatives", () => {
    expect(keep({ category: ["code"] })).toEqual(["a", "b"]);
    expect(keep({ category: ["code", "audio"] })).toEqual(["a", "b", "c"]);
  });

  it("accumulates across properties", () => {
    expect(keep({ category: ["code"], "field:priority": ["High"] })).toEqual(["b"]);
  });

  it("filters by an unfilled answer as readily as a filled one", () => {
    expect(keep({ "field:priority": [UNSET] })).toEqual(["d"]);
    expect(keep({ category: [UNSET] })).toEqual(["d"]);
  });

  it("filters by whether anything is blocking the page", () => {
    expect(keep({ blocked: ["yes"] })).toEqual(["b"]);
    expect(keep({ blocked: ["no"] })).toEqual(["a", "c", "d"]);
  });

  it("keeps every page when nothing is ticked", () => {
    expect(keep({})).toEqual(["a", "b", "c", "d"]);
    expect(keep({ category: [] })).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the counts beside each value", () => {
  it("counts a property against everything ticked elsewhere", () => {
    const priority = find("field:priority", { category: ["code"] });
    expect(priority?.values.map((value) => `${value.id}=${value.count}`)).toEqual(["Critical=1", "High=1"]);
  });

  it("leaves a property's own ticks out of its count, so a second value can be added", () => {
    // Ticking Code must not reduce Audio to zero, or there would be no way to ask for both.
    const category = find("category", { category: ["code"] });
    expect(category?.values.map((value) => `${value.id}=${value.count}`)).toEqual([
      "code=2",
      "audio=1",
      "none=1",
    ]);
  });

  it("keeps a ticked value visible after it stops matching, so it can be unticked", () => {
    const selection = { category: ["audio"], "field:priority": ["Critical"] };
    const priority = find("field:priority", selection);
    expect(priority?.values.find((value) => value.id === "Critical")).toEqual({
      id: "Critical",
      label: "Critical",
      count: 0,
    });
  });
});

describe("carrying the filters in the address bar", () => {
  it("round-trips a selection, leaving the keys legible", () => {
    const selection = { category: ["code", "audio"], blocked: ["yes"] };
    expect(encodeFacets(selection)).toBe("category=code,audio;blocked=yes");
    expect(decodeFacets(encodeFacets(selection))).toEqual(selection);
  });

  it("keeps a field's key readable rather than escaping it twice over", () => {
    expect(encodeFacets({ "field:priority": ["High"] })).toBe("field:priority=High");
  });

  it("survives values holding the characters it separates on", () => {
    const selection = { "field:notes": ["a,b", "c;d", "e=f"] };
    const encoded = encodeFacets(selection);
    expect(encoded).not.toMatch(/a,b/);
    expect(decodeFacets(encoded)).toEqual(selection);
  });

  it("writes nothing for an empty selection, and reads nothing back", () => {
    expect(encodeFacets({})).toBe("");
    expect(encodeFacets({ category: [] })).toBe("");
    expect(decodeFacets(null)).toEqual({});
    expect(decodeFacets("")).toEqual({});
  });

  it("reads a hand-edited link without throwing", () => {
    expect(decodeFacets("category")).toEqual({});
    expect(decodeFacets("category=%E0%A4%A")).toEqual({ category: ["%E0%A4%A"] });
  });
});

describe("ticking", () => {
  it("adds, removes, and forgets a property once its last value goes", () => {
    let selection = toggleFacet({}, "category", "code");
    expect(selection).toEqual({ category: ["code"] });
    selection = toggleFacet(selection, "category", "audio");
    expect(selection).toEqual({ category: ["code", "audio"] });
    selection = toggleFacet(selection, "category", "code");
    expect(selection).toEqual({ category: ["audio"] });
    selection = toggleFacet(selection, "category", "audio");
    expect(selection).toEqual({});
  });

  it("counts every ticked value, which is what the trigger reports", () => {
    expect(countSelected({})).toBe(0);
    expect(countSelected({ category: ["code", "audio"], blocked: ["yes"] })).toBe(3);
  });
});
