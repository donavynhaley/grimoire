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
  projectRole: UserRole;
};

export const CARD_STATUSES = ["backlog", "ready", "in_progress", "review", "done"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export type CardCategory = string;

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
};

export type Card = {
  id: string;
  title: string;
  description: string;
  category: CardCategory | null;
  blockedBy: string[];
  status: CardStatus;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type BoardWorkspace = {
  project: {
    id: string;
    name: string;
  };
  projects: ProjectSummary[];
  categories: ProjectCategory[];
  currentUser: User;
  members: Member[];
  cards: Card[];
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

export const AUDIT_ENTITY_TYPES = ["card", "idea", "project", "category", "member"] as const;
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
  entityType: AuditEntityType;
  entityId: string | null;
  entityTitle: string;
  action: AuditAction;
  changes: AuditChange[];
  createdAt: string;
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
