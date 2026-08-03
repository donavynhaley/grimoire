export type UserRole = "owner" | "member";

export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

export type SessionState =
  | { status: "setup_required" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: User };

export type Member = User & {
  projectRole: UserRole;
};

export const CARD_STATUSES = ["backlog", "ready", "in_progress", "done"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export type Card = {
  id: string;
  title: string;
  description: string;
  status: CardStatus;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
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
