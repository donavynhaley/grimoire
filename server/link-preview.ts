import type { ProjectCategory } from "../shared/types";
import { PAGE_COLUMN_LABELS, IDEA_LIST_LABELS } from "./audit";
import type { StoredPage } from "./markdown-pages";
import type { StoredIdea } from "./markdown-ideas";

/**
 * A shared link is unfurled by the chat client, not by the person who received it,
 * so a preview is built without a session and only ever carries what a teammate
 * needs to recognize the page: its title and where it sits on the board. The notes
 * body stays behind the login.
 */
export type LinkPreview = {
  /** Tints the stripe down the side of a Discord or Slack embed. */
  accent: string;
  /** Read as one line under the title, so each part is short and self-describing. */
  details: string[];
  projectName: string;
  title: string;
};

/** Mirrors --accent in the stylesheet, so an uncategorized page still looks like Grimoire. */
const DEFAULT_ACCENT = "#b8d99b";

const START_MARKER = "<!-- link-preview:start -->";
const END_MARKER = "<!-- link-preview:end -->";

export function pagePreview(input: {
  assigneeName: string | null;
  page: StoredPage;
  categories: ProjectCategory[];
  /** The chapter's readable name, when the project uses chapters and the page is in one. */
  chapterName?: string | null;
  projectName: string;
}): LinkPreview {
  const { assigneeName, page, categories, chapterName, projectName } = input;
  const category = categories.find((value) => value.slug === page.category);
  return {
    accent: category?.color ?? DEFAULT_ACCENT,
    details: [
      page.archivedAt === null ? PAGE_COLUMN_LABELS[page.status] : "Archived",
      page.blockedBy.length > 0 ? "Blocked" : null,
      category?.name ?? null,
      chapterName ?? null,
      assigneeName,
    ].filter((value): value is string => value !== null),
    projectName,
    title: page.title,
  };
}

export function ideaPreview(input: {
  authorName: string | null;
  idea: StoredIdea;
  projectName: string;
}): LinkPreview {
  const { authorName, idea, projectName } = input;
  return {
    accent: DEFAULT_ACCENT,
    details: ["Idea garden", ideaStanding(idea), authorName].filter((value): value is string => value !== null),
    projectName,
    title: idea.title,
  };
}

/**
 * Swaps the shell's default title and description for the shared entity's own.
 * The document is otherwise untouched, and a shell without the markers - or a link
 * that names nothing - keeps the generic Grimoire preview.
 */
export function applyLinkPreview(html: string, preview: LinkPreview | null): string {
  if (!preview) return html;
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER, start);
  if (start === -1 || end === -1) return html;
  return html.slice(0, start) + renderHead(preview) + html.slice(end + END_MARKER.length);
}

/** A promoted idea lives in the archive, so its state field no longer describes it. */
function ideaStanding(idea: StoredIdea): string {
  if (idea.promotedTo !== null) return "Promoted to a page";
  return IDEA_LIST_LABELS[idea.state];
}

function renderHead(preview: LinkPreview): string {
  const description = preview.details.join(" · ");
  return [
    `<meta name="description" content="${attribute(description)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${attribute(`Grimoire · ${preview.projectName}`)}" />`,
    `<meta property="og:title" content="${attribute(preview.title)}" />`,
    `<meta property="og:description" content="${attribute(description)}" />`,
    `<meta name="twitter:page" content="summary" />`,
    `<meta name="theme-color" content="${attribute(preview.accent)}" />`,
    `<title>${text(preview.title)} · Grimoire</title>`,
  ].join("\n    ");
}

function attribute(value: string): string {
  return text(value).replaceAll('"', "&quot;");
}

function text(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
