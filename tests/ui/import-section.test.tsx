// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ImportPlan } from "../../shared/types";
import { App } from "../../src/App";
import { settingsSectionsFor } from "../../src/components/ProjectSettingsDialog";
import { installUiHarness, type RecordedCall, response, routeFetch } from "../fixtures/ui";

installUiHarness();

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    total: 3,
    toCreate: [{ title: "Ship the settings import", status: "ready" }],
    skipped: ['card 66a1b2c40000000000000009 "Abandoned idea": archived in Trello, left behind'],
    warnings: [],
    errors: [],
    unmappedLists: [{ name: "Weird Pile", cards: 1 }],
    unmappedOptions: [],
    boards: null,
    statusChoices: null,
    ...overrides,
  };
}

const mappedPlan = plan({
  toCreate: [
    { title: "Ship the settings import", status: "ready" },
    { title: "Waiting on the mockups", status: "review" },
  ],
  unmappedLists: [],
});

/** Answers the import route the way the server does: the plan follows the mappings sent. */
function mountWith(): RecordedCall[] {
  const { calls } = routeFetch({
    routes: {
      "POST /api/import": ({ url }) => {
        if (url.includes("apply=1")) return response({ plan: mappedPlan, applied: 2 });
        if (url.includes("list=")) return response({ plan: mappedPlan, applied: null });
        return response({ plan: plan(), applied: null });
      },
    },
  });
  render(<App />);
  return calls;
}

async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
  await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
  const settings = await screen.findByRole("dialog", { name: "Project settings" });
  await user.click(within(settings).getByRole("button", { name: "Import" }));
  return settings;
}

describe("import section", () => {
  it("plans on upload and will not import while a list has no column", async () => {
    const user = userEvent.setup();
    mountWith();

    const dialog = await openImport(user);
    await user.upload(
      within(dialog).getByLabelText("Export file"),
      new File(["{}"], "board.json", { type: "application/json" }),
    );

    expect(await within(dialog).findByText("Weird Pile")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 of 3 cards import/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 stay behind/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Import 1 page/ })).toBeDisabled();
  });

  it("re-plans as the column is chosen, applies, and says what landed", async () => {
    const user = userEvent.setup();
    const calls = mountWith();

    const dialog = await openImport(user);
    await user.upload(
      within(dialog).getByLabelText("Export file"),
      new File(["{}"], "board.json", { type: "application/json" }),
    );
    await within(dialog).findByText("Weird Pile");

    await user.selectOptions(within(dialog).getByLabelText("Column for Weird Pile"), "Review");
    const apply = await within(dialog).findByRole("button", { name: /Import 2 pages/ });
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(await within(dialog).findByText("Imported 2 pages.")).toBeInTheDocument();
    const applied = calls.filter((call) => call.url.includes("/api/import") && call.url.includes("apply=1"));
    expect(applied).toHaveLength(1);
    expect(applied[0]!.url).toContain(`list=${encodeURIComponent("Weird Pile=Review").replace(/%20/g, "+")}`);
  });

  it("carries the click-path out of each source tool, one unfolding guide per bullet", async () => {
    const user = userEvent.setup();
    mountWith();

    const dialog = await openImport(user);
    const trello = within(dialog).getByRole("button", { name: "Coming from Trello" });
    expect(trello).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText(/Export as JSON/)).not.toBeInTheDocument();

    await user.click(trello);
    expect(trello).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText(/Export as JSON/)).toBeInTheDocument();

    // One question at a time: unfolding the other guide folds this one.
    await user.click(within(dialog).getByRole("button", { name: "Coming from Focalboard" }));
    expect(within(dialog).getByText(/Export board archive/)).toBeInTheDocument();
    expect(within(dialog).getByText(/leave it zipped/)).toBeInTheDocument();
    expect(trello).toHaveAttribute("aria-expanded", "false");
  });

  it("is not offered to a member at all", () => {
    expect(settingsSectionsFor(false)).not.toContain("import");
    expect(settingsSectionsFor(true)).toContain("import");
  });
});
