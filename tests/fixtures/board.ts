import type { BoardWorkspace, IdeaWorkspace } from "../../shared/types";

export function boardFixture(): BoardWorkspace {
  return {
    project: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Wizard Simulator",
    },
    currentUser: {
      id: "00000000-0000-4000-8000-000000000010",
      name: "Donavyn",
      email: "owner@example.com",
      role: "owner",
    },
    members: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        name: "Donavyn",
        email: "owner@example.com",
        role: "owner",
        projectRole: "owner",
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        name: "Maren",
        email: "maren@example.com",
        role: "member",
        projectRole: "member",
      },
    ],
    cards: [
      {
        id: "00000000-0000-4000-8000-000000000020",
        title: "Make the tower door remember Maren",
        description: "A small story interaction for the first room.",
        category: "narrative",
        blockedBy: [],
        status: "backlog",
        position: 0,
        assigneeId: null,
        assigneeName: null,
        createdById: "00000000-0000-4000-8000-000000000010",
        createdByName: "Donavyn",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000021",
        title: "Model the potion workbench",
        description: "",
        category: "modeling",
        blockedBy: [],
        status: "in_progress",
        position: 0,
        assigneeId: "00000000-0000-4000-8000-000000000011",
        assigneeName: "Maren",
        createdById: "00000000-0000-4000-8000-000000000010",
        createdByName: "Donavyn",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
  };
}

export function ideaFixture(): IdeaWorkspace {
  const board = boardFixture();
  return {
    project: board.project,
    currentUser: board.currentUser,
    ideas: [
      {
        id: "00000000-0000-4000-8000-000000000040",
        title: "Spells are assembled from drawn rune sequences",
        description: "Let experimentation reveal a small magical language.",
        state: "shortlist",
        position: 0,
        createdById: board.currentUser.id,
        createdByName: board.currentUser.name,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000041",
        title: "Familiars learn recurring player habits",
        description: "",
        state: "inbox",
        position: 0,
        createdById: board.currentUser.id,
        createdByName: board.currentUser.name,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000042",
        title: "The tower grows a garden overnight",
        description: "",
        state: "parked",
        position: 0,
        createdById: board.currentUser.id,
        createdByName: board.currentUser.name,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
  };
}
