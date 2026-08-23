// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Page, ProjectCategory, ProjectField } from "../../shared/types";
import { PageFilters } from "../../src/components/PageFilters";
import type { FacetContext, FacetSelection } from "../../src/components/page-facets";

afterEach(cleanup);

const NOW = new Date("2026-08-22T12:00:00.000Z");

const categories: ProjectCategory[] = [
  { slug: "code", name: "Code", color: "#8bb9c9", position: 0 },
  { slug: "audio", name: "Audio", color: "#b8d99b", position: 1 },
];

const fields: ProjectField[] = [
  { key: "priority", label: "Priority", type: "select", options: ["Critical", "High"], position: 0, showOnTile: true },
];

function page(id: string, over: Partial<Page>): Page {
  return {
    id,
    title: id,
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

const pages = [
  page("a", { category: "code", fields: { priority: "Critical" } }),
  page("b", { category: "code", status: "in_progress", fields: { priority: "High" } }),
  page("c", { category: "audio" }),
];

const context: FacetContext = { categories, fields, estimatesEnabled: false, now: NOW };

/** The board's own state, so ticking a value behaves the way it does in the bar. */
function Harness({ start = {} }: { start?: FacetSelection }) {
  const [selection, setSelection] = useState<FacetSelection>(start);
  return <PageFilters context={context} onChange={setSelection} pages={pages} selection={selection} />;
}

const section = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("the filter panel", () => {
  it("stays shut until it is asked for, so the bar holds one button", async () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog", { name: "Page filters" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));
    expect(screen.getByRole("dialog", { name: "Page filters" })).toBeInTheDocument();
  });

  it("opens showing every property folded, so it is a list of headings", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));

    expect(section("Category")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Code/ })).toBeNull();
  });

  it("shows a property's values, with a count, once it is unfolded", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));
    await userEvent.click(section("Category"));

    const code = screen.getByRole("button", { name: /Code/ });
    expect(within(code).getByText("2")).toBeInTheDocument();
    expect(code).toHaveAttribute("aria-pressed", "false");
  });

  it("reports what is ticked on the trigger, where it is legible with the panel shut", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));
    await userEvent.click(section("Category"));
    await userEvent.click(screen.getByRole("button", { name: /Code/ }));

    expect(screen.getByRole("button", { name: /Code/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Filter pages, 1 value chosen" })).toBeInTheDocument();
  });

  it("unfolds whatever is already filtering, so no tick is hidden inside a fold", async () => {
    render(<Harness start={{ "field:priority": ["Critical"] }} />);
    await userEvent.click(screen.getByRole("button", { name: /^Filter pages/ }));

    expect(section("Priority")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Critical/ })).toHaveAttribute("aria-pressed", "true");
    // Nothing is ticked here, so it stays folded.
    expect(section("Category")).toHaveAttribute("aria-expanded", "false");
  });

  it("offers a way out of every filter at once, and only while there is one", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));
    expect(screen.queryByRole("button", { name: "clear all" })).toBeNull();

    await userEvent.click(section("Category"));
    await userEvent.click(screen.getByRole("button", { name: /Code/ }));
    await userEvent.click(screen.getByRole("button", { name: "clear all" }));

    expect(screen.getByRole("button", { name: "Filter pages" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "clear all" })).toBeNull();
  });

  it("closes on Escape and on a click outside it", async () => {
    render(<><Harness /><button type="button">elsewhere</button></>);
    const trigger = screen.getByRole("button", { name: "Filter pages" });

    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Page filters" })).toBeNull();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog", { name: "Page filters" })).toBeNull();
  });

  it("says so plainly when a board has nothing worth filtering by", async () => {
    render(
      <PageFilters
        context={{ ...context, categories: [], fields: [] }}
        onChange={() => undefined}
        pages={[page("only", {})]}
        selection={{}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter pages" }));
    expect(screen.getByText("Nothing to filter by yet.")).toBeInTheDocument();
  });
});
