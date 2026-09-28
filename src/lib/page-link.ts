/**
 * The link a person copies when they are handing a page to somebody, or to an agent.
 *
 * The only link anyone could copy before was the address bar, which is the *filtered board*:
 * `people=`, `chapter=` and whatever else was on screen ride along with the page id, and the
 * reader has to find `page=` in the noise. This is the deep link with nothing else in it -
 * two parameters, the project and the page - so what is pasted says one thing.
 *
 * It is only the link. The title, the notes and the discussion are read at the other end,
 * against the page that is actually current; a copy of any of them taken here would start
 * going stale the moment somebody edited the page.
 */
export type PageLink = {
  /** Where this installation is served from, without a trailing slash. */
  origin: string;
  projectId: string;
  pageId: string;
};

export function pageLink({ origin, projectId, pageId }: PageLink): string {
  return `${origin.replace(/\/$/, "")}/?project=${encodeURIComponent(projectId)}&page=${encodeURIComponent(pageId)}`;
}
