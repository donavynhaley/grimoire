import type { DatabaseSync } from "node:sqlite";
import type { PageStatus } from "../shared/types";
import { createProject } from "./database";
import type { MarkdownChapterStore } from "./markdown-chapters";
import type { MarkdownPageStore } from "./markdown-pages";
import { createPage } from "./repository/pages";

/**
 * The board a fresh installation starts with.
 *
 * The first person to open Grimoire gets a project that teaches the product instead of an
 * empty one: a handful of pages spread across the columns, each explaining the part of the
 * board it sits in. Every page is ordinary — drag it, edit it, archive it — so reading the
 * board and learning to use it are the same act, and clearing it out is the first thing the
 * board teaches.
 *
 * The content lives here rather than in fixture files because it is seeded through the same
 * `createPage` every other page goes through: same validation, same Markdown files on disk,
 * same shape a build that has never seen it would read back.
 */

export const GETTING_STARTED_NAME = "Getting started";
export const GETTING_STARTED_SLUG = "getting-started";

type StarterPage = { title: string; status: PageStatus; description: string };

/** Array order is board order: pages land in each column in the order they appear here. */
export const GETTING_STARTED_PAGES: readonly StarterPage[] = [
  {
    title: "Welcome to Grimoire",
    status: "ready",
    description: [
      "A unit of work is a **page**, and this is one. Drag it between columns, open it to write in it, and archive it once it has nothing left to teach you.",
      "The board keeps to the work that currently deserves attention: **Up Next** is the small set of pages somebody can pick up now, **In progress** is what is actively being worked on, and **Done** shows what was finished most recently. Accepted work that is not yet urgent waits in the **Backlog** — a searchable library rather than a permanent column. Press `B` to open it, and `/` to search everything at once.",
      "Each page on this starter board explains one part of the product. Read them in any order, then clear them out and make the board yours.",
    ].join("\n\n"),
  },
  {
    title: "Capture work, and keep ideas apart from it",
    status: "ready",
    description: [
      "Type in the capture bar above the board and a page exists. Typing `#`, `@`, or `/` while capturing opens the category, assignee, or column picker without leaving the keyboard.",
      "Not everything belongs on the board. The **Ideas** garden (press `2`) holds possibilities: every new idea lands in the Inbox and can be shortlisted or parked without competing with committed work. Promoting an idea creates one Backlog page and archives the idea with a link to what it became, so the decision stays traceable.",
      "Notes on any page or idea are Markdown on a single always-editable surface, and they are stored as portable Markdown files on disk — readable in any editor, or inside an Obsidian vault.",
    ].join("\n\n"),
  },
  {
    title: "Turn on chapters and estimates when you want them",
    status: "backlog",
    description: [
      "This page waits in the Backlog because chapters can wait too.",
      "A **chapter** is a named stretch of the project's work, with optional dates and an intent line — the honest replacement for a sprint goal. At most one is open at a time, and closing one asks what should happen to whatever it did not finish; nothing is ever carried forward automatically.",
      "An **estimate** is one number on a page saying how much work it is. Nothing multiplies it, forecasts from it, or rolls it up on anyone's behalf.",
      "Both are off until Project settings turns them on, and a project that never does sees no trace of them. Settings is also where a project defines its own page **fields** — a priority, a due day, whatever it tracks.",
    ].join("\n\n"),
  },
  {
    title: "Talk about the work beside the work",
    status: "in_progress",
    description: [
      "Every page carries a **discussion**, and it is not the same thing as its history. The history is what the system recorded; a discussion message is authored, addressed to somebody, and finished only once it has been answered.",
      "A message with no parent opens a thread, and a thread stays open until a person marks it answered. Writing `@` and a teammate's name addresses them.",
      "The switch at the top of this panel's second column turns between the page's properties and its conversation, and a board tile says how many threads are still open — so a question is never buried under the column moves around it.",
    ].join("\n\n"),
  },
  {
    title: "Let an agent write here, and read what it wrote",
    status: "review",
    description: [
      "A project can let an AI agent work in it. The owner issues a credential in Project settings → Agent access; every write the agent makes is attributed to the person who issued it, with the agent named beside them, and revoking the credential stops it immediately.",
      "The bundled **grimoire-mcp** package is an MCP server that gives an agent these abilities as tools: it can create and edit pages and ideas, read the board, and report what it did in a page's discussion rather than over the notes a person wrote.",
      "An agent adds and refines; only a person destroys or restructures. Everything agents do waits in the agent review until somebody has looked — which is why this page sits in **Review**: delegated work is owed a reader.",
    ].join("\n\n"),
  },
  {
    title: "Stand up this installation",
    status: "done",
    description: [
      "Done, evidently. Grimoire is running, and the account that created it is the installation's one admin — the account that can never be locked out of its own instance.",
      "A completed page keeps its completion time, is never automatically archived, and can be reopened into Up Next. Clicking the **Done** heading opens the complete history, grouped by month.",
      "When the team arrives, bring them in from Project settings → Team: by email for somebody with an account, or with a single-use invitation link for somebody without one.",
    ].join("\n\n"),
  },
];

/** The one project a fresh installation starts with, made for whoever stood it up. */
export function createGettingStartedProject(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  ownerId: string,
): string {
  const projectId = createProject(database, ownerId, GETTING_STARTED_NAME, GETTING_STARTED_SLUG);
  for (const page of GETTING_STARTED_PAGES) {
    createPage(database, pageStore, chapterStore, projectId, ownerId, page);
  }
  return projectId;
}
