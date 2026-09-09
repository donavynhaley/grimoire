import type { AuditEvent, BoardWorkspace, DiscussionThread, Idea, Page } from "../../shared/types";

export type DemoProject = {
  board: BoardWorkspace;
  ideas: Idea[];
  archivedPages: Page[];
  promotions: Record<string, { idea: Idea; pageId: string }>;
  discussions: Record<string, DiscussionThread[]>;
  events: AuditEvent[];
  archivedAt: string | null;
};
export type DemoState = { projects: DemoProject[]; nextId: number; assets: Record<string, string> };
export const DEMO_OWNER = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alex",
  email: "alex@example.test",
  role: "member" as const,
};
const SEED_TIME = "2026-01-01T12:00:00.000Z";
export function demoId(state: DemoState): string {
  return `00000000-0000-4000-8000-${String(state.nextId++).padStart(12, "0")}`;
}
export function newDemoPage(id: string, title: string, now: string): Page {
  return {
    id,
    title,
    description: "",
    category: null,
    chapter: null,
    fields: {},
    blockedBy: [],
    status: "backlog",
    position: 0,
    assigneeId: null,
    assigneeName: null,
    createdById: DEMO_OWNER.id,
    createdByName: DEMO_OWNER.name,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    estimate: null,
    github: null,
    githubStatus: null,
    openThreads: 0,
    unseenMessages: 0,
    unseenMentions: 0,
  };
}
export function newDemoProject(id: string, name: string): DemoProject {
  return {
    board: {
      project: {
        id,
        name,
        description: "",
        chaptersEnabled: false,
        estimatesEnabled: false,
        githubRepo: "",
        githubTokenSet: false,
        discordWebhookSet: false,
        recapOnClose: true,
      },
      projects: [],
      categories: [
        { slug: "feature", name: "Feature", color: "#b8d99b", position: 0 },
        { slug: "design", name: "Design", color: "#8bb9c9", position: 1 },
      ],
      chapters: [],
      fields: [],
      velocity: [],
      currentUser: { ...DEMO_OWNER },
      viewerIsOwner: true,
      members: [{ ...DEMO_OWNER, projectRole: "owner" }],
      pages: [],
    },
    ideas: [],
    archivedPages: [],
    promotions: {},
    discussions: {},
    events: [],
    archivedAt: null,
  };
}
export function seedDemo(): DemoState {
  const state: DemoState = { projects: [], nextId: 10, assets: {} };
  const project = newDemoProject(demoId(state), "The Lantern Workshop");
  project.board.project.description = "A little team building a place for good ideas.";
  project.board.members.push({
    id: "00000000-0000-4000-8000-000000000002",
    name: "Morgan",
    email: "morgan@example.test",
    role: "member",
    projectRole: "member",
  });
  const examples: Array<[string, Page["status"], string]> = [
    [
      "Make yourself at home",
      "ready",
      "This is your playground. Try editing this title or these notes, move a page, or add your own.\n\nYou are Alex, the owner of this example project. Everything stays in this browser tab.\n\n- [ ] Edit a page\n- [ ] Move it to In progress\n- [ ] Start a discussion",
    ],
    [
      "Sketch the welcome page",
      "in_progress",
      "Give new visitors a friendly place to start.\n\n## A few ideas\n- A short introduction\n- A clear next step\n- Room to explore",
    ],
    [
      "Choose the workshop colors",
      "review",
      "Soft greens, warm paper, and plenty of breathing room. Open the discussion to add your thoughts.",
    ],
    ["Invite the first testers", "backlog", "Who would enjoy trying the workshop? Add your ideas here."],
    ["Open the workshop", "done", "The first milestone is ready. What should we build next?"],
  ];
  for (const [title, status, description] of examples) {
    const page = newDemoPage(demoId(state), title, SEED_TIME);
    Object.assign(page, {
      status,
      description,
      category: status === "review" ? "design" : "feature",
      position: project.board.pages.length,
    });
    if (status === "done") page.completedAt = SEED_TIME;
    project.board.pages.push(page);
  }
  const review = project.board.pages[2]!;
  project.discussions[review.id] = [
    {
      id: demoId(state),
      authorId: project.board.members[1]!.id,
      authorName: "Morgan",
      agentName: null,
      body: "I like the green. What do you think, @Alex?",
      createdAt: SEED_TIME,
      mentions: [DEMO_OWNER.id],
      replies: [],
      answeredAt: null,
      answeredById: null,
      answeredByName: null,
    },
  ];
  for (const title of ["A quiet reading corner", "Weekly community sketches"])
    project.ideas.push({
      id: demoId(state),
      title,
      description: "An idea to explore before committing to the work.",
      state: "inbox",
      position: project.ideas.length,
      createdById: DEMO_OWNER.id,
      createdByName: DEMO_OWNER.name,
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
  state.projects.push(project);
  return state;
}
