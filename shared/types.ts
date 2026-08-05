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
