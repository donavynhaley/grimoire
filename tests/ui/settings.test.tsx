// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { ArchivedProject, BoardWorkspace } from "../../shared/types";
import { boardFixture } from "../fixtures/board";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? `${input.pathname}${input.search}` : input.url;
}

type Options = {
  board?: BoardWorkspace;
  archived?: ArchivedProject[];
};

/** Mounts the app over a board, recording every write the settings dialog makes. */
function mountWith({ board = boardFixture(), archived = [] }: Options = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response({ ok: true });
    }
    if (url.startsWith("/api/projects/archived")) return response({ projects: archived });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
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
    expect(within(rail).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "General", "Categories", "Page fields", "Chapters", "GitHub", "Discord", "Team", "Agent access", "Danger zone",
    ]);
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
        currentUser: { ...board.members[1] },
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

  it("reorders a field with the position the server already stored", async () => {
    const user = userEvent.setup();
    const board = {
      ...boardFixture(),
      fields: [
        { key: "priority", label: "Priority", type: "select" as const, options: ["p0", "p1"], position: 0, showOnTile: true },
        { key: "estimate", label: "Estimate", type: "number" as const, options: [], position: 1, showOnTile: false },
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
