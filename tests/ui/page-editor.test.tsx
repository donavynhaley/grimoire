// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { BoardWorkspace } from "../../shared/types";
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

function mountWith(board: BoardWorkspace) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    if ((init.method ?? "GET") !== "GET") return response({ ok: true });
    if (url.startsWith("/api/activity")) return response({ events: [], hasMore: false });
    // The page dialog reads its discussion the same way it reads its history, on every open.
    if (/^\/api\/pages\/[^/]+\/discussion/.test(url)) return response({ threads: [] });
    if (url.startsWith("/api/away")) return response({ since: 0, latest: 0, total: 0, events: [] });
    if (url.startsWith("/api/agent-tokens")) return response({ tokens: [] });
    if (url.startsWith("/api/session")) return response({ status: "authenticated", user: board.currentUser });
    return response(board);
  });
  render(<App />);
}

/**
 * Which half of the editor is on screen is a choice the panel keeps and the stylesheet
 * honours - so what is asserted here is the choice, and the e2e suite holds the sheet to
 * the widths where it actually changes what you can see.
 */
describe("the page editor's two halves", () => {
  it("opens on the writing and stays pointed at whichever half was asked for", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1].title));
    const split = document.querySelector(".page-editor-split");
    expect(split).toHaveAttribute("data-pane", "notes");

    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(split).toHaveAttribute("data-pane", "details");

    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(split).toHaveAttribute("data-pane", "notes");
  });

  it("keeps the archive and the autosave line out of both halves, under them", async () => {
    const user = userEvent.setup();
    const board = boardFixture();
    mountWith(board);

    await user.click(await screen.findByText(board.pages[1].title));
    const panel = screen.getByRole("dialog", { name: "Edit page" });

    // Whichever half is showing, these are still the panel's own furniture.
    for (const selector of [".autosave-state", ".dialog-footer"]) {
      const element = panel.querySelector(selector);
      expect(element).not.toBeNull();
      expect(element!.closest(".page-editor-split")).toBeNull();
    }
  });
});
