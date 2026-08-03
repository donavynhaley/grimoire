import type { Workspace } from "../../shared/types";

export function workspaceFixture(): Workspace {
  return {
    project: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Wizard Simulator",
      slug: "wizard-simulator",
      pitch: "A tactile first-person fantasy simulator.",
      playerFantasy: "Become a working wizard.",
      currentDirection: "Make Wizard Sight essential, strange, and useful.",
      directionDetail: "Build one investigation that requires magical observation.",
      nonGoals: "No multiplayer during this focus.",
    },
    currentUser: {
      id: "00000000-0000-4000-8000-000000000010",
      name: "Donavyn",
      email: "donavyn@example.com",
      role: "owner",
    },
    members: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        name: "Donavyn",
        email: "donavyn@example.com",
        role: "owner",
        projectRole: "owner",
      },
    ],
    pillars: [
      {
        id: "00000000-0000-4000-8000-000000000020",
        title: "Knowledge changes perception",
        description: "Learning reveals relationships that were previously invisible.",
        position: 0,
      },
    ],
    milestones: [
      {
        id: "00000000-0000-4000-8000-000000000030",
        title: "Wizard Sight vertical slice",
        description: "One complete magical discovery.",
        status: "active",
        position: 0,
        conditions: [
          {
            id: "00000000-0000-4000-8000-000000000031",
            title: "One discovery is ready for playtesting",
            complete: false,
            position: 0,
          },
        ],
      },
    ],
    ideas: [
      {
        id: "00000000-0000-4000-8000-000000000040",
        title: "Let awakened objects remember previous wizards",
        notes: "",
        status: "inbox",
        horizon: "later",
        creatorId: "00000000-0000-4000-8000-000000000010",
        creatorName: "Donavyn",
        promotedOutcomeId: null,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
    outcomes: [],
    workItems: [],
    assets: [],
    builds: [],
    playtests: [],
    comments: [],
    activity: [],
  };
}

