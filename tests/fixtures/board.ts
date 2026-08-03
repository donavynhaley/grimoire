import type { BoardWorkspace } from "../../shared/types";

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
