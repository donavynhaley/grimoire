import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Imported from the package's dependency-free modules only - never from server.ts, whose
// SDK import would make this suite depend on the package's own install step. The root
// `npm test` must hold the contract on a fresh clone, and in CI it runs first.
import {
  BODY_MAX_LENGTH as AGENT_BODY_MAX_LENGTH,
  DISCUSSION_BODY_MAX_LENGTH as AGENT_DISCUSSION_BODY_MAX_LENGTH,
  type Board as AgentBoard,
  type Page as AgentPage,
  type SearchResults as AgentSearchResults,
  MCP_VERSION,
} from "../../packages/grimoire-mcp/src/client";
import { columnLabel, PAGE_COLUMNS } from "../../packages/grimoire-mcp/src/resolve";
import {
  BODY_MAX_LENGTH,
  type BoardWorkspace,
  DISCUSSION_BODY_MAX_LENGTH,
  PAGE_STATUS_LABELS,
  PAGE_STATUSES,
  type Page,
  type SearchResults,
} from "../../shared/types";

/**
 * The MCP package re-declares the shapes it reads, deliberately: it ships to npm on its
 * own and imports nothing from the application. That isolation is sound and this test is
 * its price - the copies stay honest here, at compile time for the types and at run time
 * for the mirrored constants, instead of by a comment asking them to move together.
 */

// A real server payload must satisfy every shape the package hand-declares. A field the
// package types wrongly, or invents, fails these assignments at compile time.
const page: AgentPage = {} as Page;
const board: AgentBoard = {} as BoardWorkspace;
const hits: AgentSearchResults = {} as SearchResults;
// And the narrowing holds in the other direction where it matters: the package's column
// union must never widen past the product's, or resolveStatus starts accepting words the
// server will refuse.
const status: Page["status"] = {} as AgentPage["status"];
void page;
void board;
void hits;
void status;

describe("the mcp package's mirrors", () => {
  it("carries the same body limits the server enforces", () => {
    expect(AGENT_BODY_MAX_LENGTH).toBe(BODY_MAX_LENGTH);
    expect(AGENT_DISCUSSION_BODY_MAX_LENGTH).toBe(DISCUSSION_BODY_MAX_LENGTH);
  });

  it("speaks the same column vocabulary, with the same labels", () => {
    expect([...PAGE_COLUMNS]).toEqual([...PAGE_STATUSES]);
    for (const value of PAGE_STATUSES) {
      expect(columnLabel(value)).toBe(PAGE_STATUS_LABELS[value]);
    }
  });

  it("announces the version its package.json ships", () => {
    const packaged = JSON.parse(
      readFileSync(new URL("../../packages/grimoire-mcp/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(MCP_VERSION).toBe(packaged.version);
  });
});
