// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace, ProjectField } from "../../shared/types";
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

const priority: ProjectField = {
  key: "priority",
  label: "Priority",
  type: "select",
  options: ["p0", "p1", "p2"],
  position: 0,
  showOnTile: true,
};

const estimate: ProjectField = {
  key: "estimate",
  label: "Estimate",
  type: "number",
  options: [],
  position: 1,
  showOnTile: false,
};

/** Mounts the app over a board, recording every write the field UI makes. */
function mountWith(board: BoardWorkspace) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      return response({ ok: true });
    }
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
  return calls;
}

async function openFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Wizard Simulator/ }));
  await user.click(screen.getByRole("menuitem", { name: /Project settings/ }));
  const settings = await screen.findByRole("dialog", { name: "Project settings" });
  await user.click(within(settings).getByRole("button", { name: "Page fields" }));
  return settings;
}

describe("page fields", () => {
  it("captures a page with a project field chosen from the capture bar", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), fields: [priority, estimate] };
    const calls = mountWith(board);

    await user.type(await screen.findByLabelText("Capture work page"), "Tune the familiar");
    // Only fields a picker can answer get chips; a number is typing, and stays in the editor.
    expect(screen.queryByRole("button", { name: "Choose Estimate" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose Priority" }));
    await user.click(screen.getByRole("option", { name: "p1" }));
    await user.click(screen.getByRole("button", { name: "add page" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/pages",
        method: "POST",
        body: {
          title: "Tune the familiar",
          category: null,
          chapter: null,
          assigneeId: null,
          status: "backlog",
          fields: { priority: "p1" },
        },
      }),
    );
  });

  it("clears a chosen capture field by picking not set", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), fields: [priority] };
    mountWith(board);

    await user.type(await screen.findByLabelText("Capture work page"), "Anything");
    await user.click(screen.getByRole("button", { name: "Choose Priority" }));
    await user.click(screen.getByRole("option", { name: "p2" }));
    expect(screen.getByRole("button", { name: "Priority: p2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Priority: p2" }));
    await user.click(screen.getByRole("option", { name: "Not set" }));
    expect(screen.getByRole("button", { name: "Choose Priority" })).toBeInTheDocument();
  });

  it("offers the section from project settings, saying what fields are for", async () => {
    const user = userEvent.setup();
    mountWith(boardFixture());

    const settings = await openFields(user);
    expect(within(settings).getByText(/whatever this project tracks/)).toBeInTheDocument();
  });

  it("opens straight onto the fields section from a settings link", async () => {
    window.history.replaceState({}, "", "/?settings=fields");
    mountWith(boardFixture());

    // The section travels in the URL, so a reload or a shared link lands exactly here.
    const settings = await screen.findByRole("dialog", { name: "Project settings" });
    expect(await within(settings).findByText(/whatever this project tracks/)).toBeInTheDocument();
  });

  it("defines a choice field with its options", async () => {
    const user = userEvent.setup();
    const calls = mountWith(boardFixture());

    const dialog = await openFields(user);
    await user.click(within(dialog).getByRole("button", { name: "choice" }));
    await user.type(within(dialog).getByLabelText("New field name"), "Priority");
    await user.type(within(dialog).getByLabelText("Options"), "p0, p1, p2");
    await user.click(within(dialog).getByRole("button", { name: "add" }));

    expect(calls).toContainEqual({
      url: "/api/fields",
      method: "POST",
      body: { label: "Priority", type: "select", options: ["p0", "p1", "p2"] },
    });
  });

  it("will not add a choice field with no options to choose from", async () => {
    const user = userEvent.setup();
    mountWith(boardFixture());

    const dialog = await openFields(user);
    await user.click(within(dialog).getByRole("button", { name: "choice" }));
    await user.type(within(dialog).getByLabelText("New field name"), "Priority");

    expect(within(dialog).getByRole("button", { name: "add" })).toBeDisabled();
  });

  it("warns that deleting a field takes its values with it", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), fields: [priority] };
    mountWith(board);

    const dialog = await openFields(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete Priority" }));

    expect(within(dialog).getByText(/clears its value from every page/)).toBeInTheDocument();
  });

  it("sets a value on a page by clicking the option, sending only that field", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), fields: [priority, estimate] };
    // The second fixture page is the one in a column the board actually draws.
    board.pages[1] = { ...board.pages[1], fields: { estimate: 5 } };
    const calls = mountWith(board);

    await user.click(await screen.findByRole("button", { name: /Open Model the potion workbench/ }));
    await user.click(await screen.findByRole("button", { name: "Set Priority to p0" }));

    // A patch, so the estimate the page already carries is not restated and cannot be lost.
    expect(calls).toContainEqual({
      url: `/api/pages/${board.pages[1].id}`,
      method: "PATCH",
      body: { fields: { priority: "p0" } },
    });
  });

  it("clears a value with none, which is how a field is emptied", async () => {
    const user = userEvent.setup();
    const board = { ...boardFixture(), fields: [priority] };
    board.pages[1] = { ...board.pages[1], fields: { priority: "p1" } };
    const calls = mountWith(board);

    await user.click(await screen.findByRole("button", { name: /Open Model the potion workbench/ }));
    await user.click(await screen.findByRole("button", { name: "Clear Priority" }));

    expect(calls).toContainEqual({
      url: `/api/pages/${board.pages[1].id}`,
      method: "PATCH",
      body: { fields: { priority: null } },
    });
  });

  it("shows only tile-marked fields on the board, and only where a page has one", async () => {
    const board = { ...boardFixture(), fields: [priority, estimate] };
    board.pages[1] = { ...board.pages[1], fields: { priority: "p0", estimate: 8 } };
    mountWith(board);

    // Priority is marked for tiles; the estimate is not, so 8 stays inside the page.
    await waitFor(() => expect(screen.getByText("p0")).toBeInTheDocument());
    expect(screen.queryByText("8")).not.toBeInTheDocument();
    // And the second page carries no values, so it grows no chips at all.
    expect(screen.getAllByText("p0")).toHaveLength(1);
  });
});
