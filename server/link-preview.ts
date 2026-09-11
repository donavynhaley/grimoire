/** Only project names and descriptions may be published to anonymous link crawlers. */
export type LinkPreview = {
  title: string;
  description: string;
};

const START_MARKER = "<!-- link-preview:start -->";
const END_MARKER = "<!-- link-preview:end -->";

/**
 * Swaps the shell's default title and description for the shared project's own.
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

function renderHead(preview: LinkPreview): string {
  const description =
    preview.description.trim() || "Grimoire is a focused collaborative kanban board for small product teams.";
  return [
    `<meta name="description" content="${attribute(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Grimoire" />`,
    `<meta property="og:title" content="${attribute(preview.title)}" />`,
    `<meta property="og:description" content="${attribute(description)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<title>${text(preview.title)} · Grimoire</title>`,
  ].join("\n    ");
}

function attribute(value: string): string {
  return text(value).replaceAll('"', "&quot;");
}

function text(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
