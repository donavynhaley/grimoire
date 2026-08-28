// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import type { ArchivedProject, BoardWorkspace } from "../../shared/types";
import { boardFixture } from "../fixtures/board";
import { installUiHarness, routeFetch, type RecordedCall } from "../fixtures/ui";

installUiHarness();

type Options = {
  board?: BoardWorkspace;
  archived?: ArchivedProject[];
};

/** Mounts the app over a board, recording every write the settings dialog makes. */
function mountWith({ board = boardFixture(), archived = [] }: Options = {}): RecordedCall[] {
  const { calls } = routeFetch({
    board,
    routes: { "GET /api/projects/archived": { projects: archived } },
  });
  render(<App />);
  return calls;
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
  await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
  return screen.findByRole("dialog", { name: "Project settings" });
}

describe("the one settings surface", () => {
  it("is one dialog named for itself, with a rail instead of satellite dialogs", async () => {
    const user = userEvent.setup();
    mountWith();

    const settings = await openSettings(user);
    const rail = within(settings).getByRole("navigation", { name: "Settings sections" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "General",
      "Categories",
      "Page fields",
      "Chapters",
      "GitHub",
      "Discord",
      "Team",
      "Agent access",
      "Sign-in",
      "Danger zone",
    ]);
  });

  it("keeps how everybody signs in out of a project owner's settings", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    // An owner of this project, but not the account that set the installation up. A provider
    // reaches every board, so it is not theirs to change.
    board.currentUser = { ...board.currentUser, role: "member" };
    mountWith({ board });

    const settings = await openSettings(user);
    const rail = within(settings).getByRole("navigation", { name: "Settings sections" });
    const sections = within(rail)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(sections).toContain("Agent access");
    expect(sections).not.toContain("Sign-in");
  });

  it("auto-saves a rename on blur and says so", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    const calls = mountWith({ board });

    const settings = await openSettings(user);
    const name = within(settings).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Wizard Simulator II");
    await user.tab();

    // The missing half of auto-save was never the model, it was the feedback.
    expect(await within(settings).findByText("saved")).toBeInTheDocument();
    expect(calls).toContainEqual({
      url: `/api/projects/${board.project.id}`,
      method: "PATCH",
      body: { name: "Wizard Simulator II" },
    });
  });

  it("gives the project a description that saves on blur", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    const calls = mountWith({ board });

    const settings = await openSettings(user);
    await user.type(within(settings).getByLabelText("Description"), "A cozy wizard-life sim");
    await user.tab();

    expect(await within(settings).findByText("saved")).toBeInTheDocument();
    expect(calls).toContainEqual({
      url: `/api/projects/${board.project.id}`,
      method: "PATCH",
      body: { description: "A cozy wizard-life sim" },
    });
  });

  it("lets a member read the shape of the project without offering any mutation", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith({
      board: {
        ...board,
        currentUser: { ...board.members[1]! },
        viewerIsOwner: false,
      },
    });

    const settings = await openSettings(user);
    // Read-only text, not inputs: the name and description are facts here, not fields.
    expect(within(settings).queryByLabelText("Name")).toBeNull();
    expect(within(settings).getByText("No description yet.")).toBeInTheDocument();

    await user.click(within(settings).getByRole("button", { name: "Categories" }));
    expect(within(settings).getByText("Design")).toBeInTheDocument();
    expect(within(settings).queryByRole("button", { name: /Delete Design/ })).toBeNull();
  });

  /*
   * The one account that reaches every project read as an ordinary owner, because the role
   * column is about this project and nothing anywhere said otherwise.
   */
  it("names the installation's admin beside their name, without disturbing the project role", async () => {
    const user = userEvent.setup();
    mountWith();

    const settings = await openSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Team" }));

    // Donavyn is the admin of the installation and the owner of this project: both are said.
    const donavyn = within(settings).getByText("owner@example.com").closest(".team-member")!;
    expect(within(donavyn as HTMLElement).getByText("admin")).toBeInTheDocument();
    expect(within(donavyn as HTMLElement).getByText("owner")).toBeInTheDocument();
    // Maren is neither, and gains no badge from standing next to one.
    const maren = within(settings).getByText("maren@example.com").closest(".team-member")!;
    expect(within(maren as HTMLElement).queryByText("admin")).toBeNull();
  });

  it("adds somebody who already has an account, which an invitation cannot do", async () => {
    const user = userEvent.setup();
    const calls = mountWith();

    const settings = await openSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Team" }));
    await user.type(within(settings).getByLabelText("Email address"), "alan@example.com");
    await user.click(within(settings).getByRole("button", { name: "add" }));

    await waitFor(() =>
      expect(calls.find((call) => call.url === "/api/members")).toMatchObject({
        method: "POST",
        body: { email: "alan@example.com" },
      }),
    );
  });

  it("reorders a field with the position the server already stored", async () => {
    const user = userEvent.setup();
    const board = {
      ...boardFixture(),
      fields: [
        {
          key: "priority",
          label: "Priority",
          type: "select" as const,
          options: ["p0", "p1"],
          position: 0,
          showOnTile: true,
        },
        {
          key: "estimate",
          label: "Estimate",
          type: "number" as const,
          options: [],
          position: 1,
          showOnTile: false,
        },
      ],
    };
    const calls = mountWith({ board });

    const settings = await openSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Page fields" }));
    await user.click(within(settings).getByRole("button", { name: "Move Estimate up" }));

    // The two neighbours trade indexes; nothing else in the list moves.
    expect(await within(settings).findByText("saved")).toBeInTheDocument();
    expect(calls).toContainEqual({ url: "/api/fields/estimate", method: "PATCH", body: { position: 0 } });
    expect(calls).toContainEqual({ url: "/api/fields/priority", method: "PATCH", body: { position: 1 } });
  });

  it("lists archived projects in the danger zone and restores one", async () => {
    const user = userEvent.setup();
    const calls = mountWith({
      archived: [{ id: "archived-1", name: "Familiar Tycoon", archivedAt: "2026-08-01T00:00:00.000Z" }],
    });

    const settings = await openSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Danger zone" }));
    expect(await within(settings).findByText("Familiar Tycoon")).toBeInTheDocument();
    await user.click(within(settings).getByRole("button", { name: "Restore Familiar Tycoon" }));

    expect(await within(settings).findByText("saved")).toBeInTheDocument();
    expect(calls).toContainEqual({
      url: "/api/projects/archived-1/restore",
      method: "POST",
      body: {},
    });
  });
});
