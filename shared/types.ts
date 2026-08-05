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

export const CARD_CATEGORIES = [
  "design",
  "code",
  "modeling",
  "texturing",
  "animation",
  "narrative",
  "audio",
  "ui",
  "vfx",
  "production",
] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

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
