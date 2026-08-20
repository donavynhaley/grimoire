export type UserRole = "owner" | "member";

export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl?: string | null;
};

export type SessionState =
  | { status: "setup_required" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: User };

export type Member = User & {
  /**
   * Mirrors the account-wide `role` on purpose. Owner powers are not per-project - promoting
   * someone here grants them everywhere - and the two are kept in lockstep so the board never
   * shows a member who can in fact restructure it. See `setMemberRole` in the repository.
   */
  projectRole: UserRole;
};

export const PAGE_STATUSES = ["backlog", "ready", "in_progress", "review", "done"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export type PageCategory = string;

export type ProjectCategory = {
  slug: string;
  name: string;
  color: string;
  position: number;
};

export const CATEGORY_COLOR_PALETTE = [
  "#d6bc78",
  "#8bb9c9",
  "#b49bd4",
  "#d89b73",
  "#d88eae",
  "#a99bdc",
  "#b8d99b",
  "#74c6bf",
  "#d284d3",
  "#a7adaf",
  "#d87578",
  "#9ccc9c",
] as const;

export type ProjectSummary = {
  id: string;
  name: string;
  /** One optional sentence saying what the project is, shown in the switcher. */
  description: string;
};

/** An archived project as the owner's restore list shows it. */
export type ArchivedProject = {
  id: string;
  name: string;
  archivedAt: string;
};

/**
 * A property a project decided its own pages should carry.
 *
 * Grimoire has no opinion about what a team tracks, and every attempt to guess produced a
 * field somebody had to ignore. So the shapes are primitive and the meanings are the
 * project's: one team's `select` is a priority, another's is a risk level, and neither is
 * named in this file. Nothing here counts, rolls up, or computes - a number field is a
 * number a person wrote down, not an estimate the board will add up behind them.
 *
 * Defining a field is restructuring the project, so it is owner-only. Filling one in is
 * refining a page, so an agent may do it.
 */
export const FIELD_TYPES = ["text", "number", "select", "search-select", "date", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Both kinds of choice field: same options, same validation - they differ only in how they present. */
export function fieldHasOptions(type: FieldType): boolean {
  return type === "select" || type === "search-select";
}

export type ProjectField = {
  /** Stable across renames, and what a page's `fields` record is keyed by. */
  key: string;
  label: string;
  type: FieldType;
  /** What a `select` may hold, in the order it offers them. Empty for every other type. */
  options: string[];
  position: number;
  /** Whether a board tile shows it, so a project can carry more than it puts on the board. */
  showOnTile: boolean;
};

/** `date` is a plain `YYYY-MM-DD` day, like a chapter's, not an instant. */
export type FieldValue = string | number | boolean;

/**
 * The values a page actually has, keyed by field.
 *
 * A field the page never filled in is absent rather than null, so an empty record and an
 * untouched page are the same thing and neither writes anything to disk.
 */
export type PageFields = Record<string, FieldValue>;

/**
 * A named stretch of the project's work, which pages can belong to.
 *
 * A chapter answers "what were we working on, and roughly when", never "how much did we
 * commit to". It carries no estimate, no capacity, and no progress figure, and nothing in
 * it moves a page on its own. Dates are optional and descriptive: a chapter with neither
 * is still a chapter, and one whose end date has passed keeps running until someone closes it.
 */
export const CHAPTER_STATES = ["planned", "open", "closed"] as const;
export type ChapterState = (typeof CHAPTER_STATES)[number];

export type Chapter = {
  /** Stable across renames, and what a page's `chapter` field points at. */
  slug: string;
  name: string;
  /** Markdown notes saying what this stretch is for. The honest replacement for a sprint goal. */
  description: string;
  state: ChapterState;
  position: number;
  /** Plain `YYYY-MM-DD` days the team named, not instants. Either may be absent. */
  startsOn: string | null;
  endsOn: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /**
   * What was still unfinished when this chapter closed, recorded at the moment it closed.
   *
   * Counted then rather than derived later because the pages themselves move on: once they
   * belong to the next chapter, nothing about them still says they were carried out of this
   * one. Null until the chapter has been closed at all.
   */
  carriedPages: number | null;
  carriedEstimate: number | null;
  /** Where the unfinished work went, when it went somewhere. */
  carriedTo: string | null;
  /**
   * What this chapter delivered, counted the moment it closed.
   *
   * Both readings are kept: how many pages were finished in it, and what those pages were
   * estimated at. A team that estimates everything reads the second; a team that estimates
   * some of its work still has the first, and neither is derived from the other.
   *
   * Recorded rather than recomputed because a closed chapter is history: pages archived,
   * reopened, or re-placed afterwards would otherwise quietly rewrite what a finished
   * stretch of work is remembered as having delivered. Null until the chapter closes.
   */
  deliveredPages: number | null;
  deliveredEstimate: number | null;
};

/**
 * What a chapter delivered, and what it did not.
 *
 * Delivered counts pages finished while they belonged to this chapter, which is the only
 * honest reading: rollover moves unfinished work onward, so a page that carried over is
 * counted by whichever chapter it was actually finished in. Nothing here is a forecast -
 * the product refuses to estimate on anyone's behalf - it only adds up what happened.
 */
/**
 * What a chapter delivered, said as facts for something else to narrate.
 *
 * Served as well as posted: the plain Discord message is built from exactly this, so an
 * agent that wants to write the story reads the same numbers rather than a second version
 * of them.
 */
export type ChapterRecap = {
  chapter: Chapter;
  delivered: number;
  deliveredEstimate: number;
  carriedPages: number;
  carriedEstimate: number;
  carriedTo: string | null;
  /** The mean of what earlier chapters delivered, or null when there is nothing to compare. */
  averageDelivered: number | null;
  averageDeliveredEstimate: number | null;
  byPerson: Array<{
    memberId: string;
    name: string;
    shipped: number;
    shippedEstimate: number;
    inFlight: number;
    titles: string[];
  }>;
  unassignedDelivered: number;
  stillOpen: { ready: number; inProgress: number; review: number };
  project: { done: number; backlog: number; total: number };
};

export type ChapterVelocity = {
  slug: string;
  /** Both readings of what was delivered: the count of pages, and what they were estimated at. */
  donePages: number;
  doneEstimate: number;
  openPages: number;
  openEstimate: number;
  /** Pages estimated at nothing, so a reader can tell an empty total from an unestimated one. */
  unestimatedPages: number;
  /**
   * True once the chapter has closed and these numbers are the ones it recorded, rather than
   * a live count of whatever happens to point at it now.
   */
  recorded: boolean;
};

/**
 * A page's tie to the work in GitHub: a pull request by number, or a branch a pull
 * request will eventually be opened from. The repository is usually the project's
 * configured one; a link pasted as a full URL may name another and carries it here.
 */
export type PageGithubLink =
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "branch"; name: string; repo?: string };

/** What GitHub last said about a linked page, cached server-side between polls. */
export type PageGithubStatus = {
  state: "open" | "draft" | "merged" | "closed" | "missing" | "unchecked";
  /** Present once a pull request exists, including one adopted for a branch link. */
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  checkedAt: string | null;
};

export type Page = {
  id: string;
  title: string;
  description: string;
  category: PageCategory | null;
  /**
   * The chapter this page belongs to, or null.
   *
   * Deliberately independent of `status`: a page can sit in the Backlog while already
   * belonging to a chapter, which is what lets a chapter be filled without flooding Up Next.
   */
  chapter: string | null;
  /** Values for the project's own fields. Absent keys were never filled in. */
  fields: PageFields;
  blockedBy: string[];
  status: PageStatus;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /**
   * How much work this page is, in whatever unit the team means by it.
   *
   * Nothing multiplies, forecasts, or rolls this up on anyone's behalf; it is added together
   * per chapter and shown, and that is all. Null when nobody has said, and always null while
   * the project has estimates switched off.
   */
  estimate: number | null;
  /** The GitHub work this page is tied to, or null. */
  github: PageGithubLink | null;
  /** What GitHub last said about that link; null when the page has none. */
  githubStatus: PageGithubStatus | null;
};

export type BoardWorkspace = {
  project: {
    id: string;
    name: string;
    /** One optional sentence saying what the project is. Empty until someone writes it. */
    description: string;
    /** Off unless this project asked for chapters. When false the interface shows none of them. */
    chaptersEnabled: boolean;
    /** "owner/name" of the repository this project's pull requests live in, or empty. */
    githubRepo: string;
    /** Whether a token is held for that repository; the token itself never leaves the server. */
    githubTokenSet: boolean;
    /** Off unless this project asked for estimates. When false, no page carries one. */
    estimatesEnabled: boolean;
    /** Whether a Discord webhook is held for recaps; the URL itself never leaves the server. */
    discordWebhookSet: boolean;
    /** Whether closing a chapter posts its recap without being asked. */
    recapOnClose: boolean;
  };
  projects: ProjectSummary[];
  categories: ProjectCategory[];
  /** What this project chose its pages should carry. Empty until someone defines one. */
  fields: ProjectField[];
  /** Empty when the gate is off, so a disabled project carries no chapter surface at all. */
  chapters: Chapter[];
  /** One entry per chapter, empty when either chapters or estimates are off. */
  velocity: ChapterVelocity[];
  currentUser: User;
  members: Member[];
  pages: Page[];
};

export const IDEA_STATES = ["inbox", "shortlist", "parked"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

export type Idea = {
  id: string;
  title: string;
  description: string;
  state: IdeaState;
  position: number;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type IdeaWorkspace = {
  project: {
    id: string;
    name: string;
  };
  currentUser: User;
  ideas: Idea[];
};

/**
 * Where a search result lives, in the order the overlay presents its groups.
 *
 * The group answers "where would I go to act on this", which is why backlog and
 * completed work are separated from the active board rather than folded into it.
 */
export const SEARCH_GROUPS = ["active", "backlog", "ideas", "done", "archived"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export type SearchHit = {
  kind: "page" | "idea";
  group: SearchGroup;
  id: string;
  title: string;
  /** A plain-text window around the first note match, or "" when only the title matched. */
  snippet: string;
  /** The column, idea state, or archival note, as a reader would name it. */
  where: string;
  category: string | null;
  categoryColor: string | null;
  assigneeName: string | null;
};

export type SearchResults = {
  query: string;
  /** Exact match count, even when `hits` was capped. */
  total: number;
  hits: SearchHit[];
};

/**
 * A rejected write, returned instead of overwriting content the client never saw.
 *
 * `current` carries the stored record so the editor can show what it collided with
 * without a second request.
 */
export type EditConflict<T> = {
  error: string;
  conflict: true;
  field: "title" | "description";
  current: T;
};

export const AUDIT_ENTITY_TYPES = ["page", "idea", "project", "category", "chapter", "member", "agent", "field"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "moved",
  "archived",
  "restored",
  "promoted",
  "renamed",
  "deleted",
  "invited",
  "joined",
  "removed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One field that differed, already rendered for people rather than for code. */
export type AuditChange = {
  field: string;
  from: string | null;
  to: string | null;
};

export type AuditEvent = {
  /** Monotonic write order, used as the paging cursor. */
  sequence: number;
  id: string;
  actorId: string | null;
  actorName: string;
  /**
   * The agent that made this write on the actor's behalf, or null for a person at a browser.
   *
   * Separate from `actorName` because that name is resolved to the live account on every
   * read, so a label folded into it would be discarded before anyone saw it.
   */
  agentName: string | null;
  entityType: AuditEntityType;
  entityId: string | null;
  entityTitle: string;
  action: AuditAction;
  changes: AuditChange[];
  createdAt: string;
};

/** What a token may do. An agent adds and refines; only a person destroys or restructures. */
export const AGENT_TOKEN_SCOPES = ["read", "write"] as const;
export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number];

/**
 * An issued agent credential, as anyone but its holder ever sees it.
 *
 * The secret itself is returned exactly once, at creation, and only its hash is stored.
 */
export type AgentToken = {
  id: string;
  name: string;
  scope: AgentTokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** The person the token acts as. Every write it makes is attributed to them. */
  ownerName: string;
};

export type AuditPage = {
  events: AuditEvent[];
  hasMore: boolean;
};

/**
 * What happened since this reader's last visible visit.
 *
 * `since` is the boundary the digest and markers are computed from, `latest` is the
 * newest sequence the project has written, and `events` holds up to the away cap
 * while `total` stays exact.
 */
export type AwayState = {
  since: number;
  latest: number;
  total: number;
  events: AuditEvent[];
};
