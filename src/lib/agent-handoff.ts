/**
 * The block a person copies when they are handing a page to an agent.
 *
 * The only link anyone could copy before was the address bar, which is the *filtered board*:
 * `people=`, `chapter=` and whatever else was on screen ride along with the page id, and the
 * agent has to find `page=` in the noise. This is the deep link with nothing else in it -
 * two parameters, the project and the page - so what is pasted says one thing.
 *
 * What is deliberately absent is the brief. Not the notes, not the discussion. An agent reads
 * those through its own credential, against the page that is actually current; copying them
 * here would fork the brief into a place the discussion cannot follow, and the copy would
 * start going stale the moment somebody edited the page.
 */
export type AgentHandoff = {
  /** Where this installation is served from, without a trailing slash. */
  origin: string;
  projectId: string;
  projectName: string;
  pageId: string;
  title: string;
};

export function agentHandoffText({ origin, projectId, projectName, pageId, title }: AgentHandoff): string {
  const link = `${origin.replace(/\/$/, "")}/?project=${encodeURIComponent(projectId)}&page=${encodeURIComponent(pageId)}`;
  return [`Grimoire page ${pageId} in project "${projectName}"`, title, link].join("\n");
}
