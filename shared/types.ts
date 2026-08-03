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

export type Project = {
  id: string;
  name: string;
  slug: string;
  pitch: string;
  playerFantasy: string;
  currentDirection: string;
  directionDetail: string;
  nonGoals: string;
};

export type Member = User & {
  projectRole: UserRole;
};

export type Pillar = {
  id: string;
  title: string;
  description: string;
  position: number;
};

export type MilestoneCondition = {
  id: string;
  title: string;
  complete: boolean;
  position: number;
};

export type Milestone = {
  id: string;
  title: string;
  description: string;
  status: "planned" | "active" | "complete";
  position: number;
  conditions: MilestoneCondition[];
};

export type IdeaStatus = "inbox" | "considering" | "later" | "promoted" | "rejected";
export type Idea = {
  id: string;
  title: string;
  notes: string;
  status: IdeaStatus;
  horizon: "now" | "next" | "later";
  creatorId: string;
  creatorName: string;
  promotedOutcomeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutcomeStatus =
  | "shaping"
  | "ready"
  | "active"
  | "playtest"
  | "integrated"
  | "validated"
  | "revise"
  | "cut";

export type Outcome = {
  id: string;
  title: string;
  description: string;
  status: OutcomeStatus;
  ownerId: string | null;
  ownerName: string | null;
  milestoneId: string | null;
  pillarId: string | null;
  definitionOfPlayable: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkStatus = "blocked" | "ready" | "doing" | "review" | "done";
export type WorkItem = {
  id: string;
  outcomeId: string;
  title: string;
  discipline: string;
  status: WorkStatus;
  ownerId: string | null;
  ownerName: string | null;
  description: string;
  position: number;
  dependencyIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type AssetStage = {
  id: string;
  label: string;
  status: "waiting" | "ready" | "doing" | "review" | "done";
  ownerId: string | null;
  ownerName: string | null;
  position: number;
  handoffNote: string;
};

export type Asset = {
  id: string;
  outcomeId: string | null;
  name: string;
  type: string;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  sourceUrl: string;
  notes: string;
  stages: AssetStage[];
  createdAt: string;
  updatedAt: string;
};

export type Build = {
  id: string;
  name: string;
  summary: string;
  knownIssues: string;
  creatorName: string;
  builtAt: string;
};

export type Playtest = {
  id: string;
  outcomeId: string | null;
  buildId: string | null;
  title: string;
  observations: string;
  decision: "undecided" | "keep" | "revise" | "cut";
  creatorName: string;
  playedAt: string;
};

export type Activity = {
  id: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: string;
};

export type Comment = {
  id: string;
  entityType: string;
  entityId: string;
  body: string;
  authorName: string;
  createdAt: string;
};

export type Workspace = {
  project: Project;
  currentUser: User;
  members: Member[];
  pillars: Pillar[];
  milestones: Milestone[];
  ideas: Idea[];
  outcomes: Outcome[];
  workItems: WorkItem[];
  assets: Asset[];
  builds: Build[];
  playtests: Playtest[];
  comments: Comment[];
  activity: Activity[];
};

