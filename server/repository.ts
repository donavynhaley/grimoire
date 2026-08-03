import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CARD_STATUSES,
  type BoardWorkspace,
  type Card,
  type CardStatus,
  type Member,
  type User,
} from "../shared/types";
import { MarkdownCardStore, type StoredCard } from "./markdown-cards";

type Row = Record<string, string | number | null>;

function rows(database: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return database.prepare(sql).all(...params) as Row[];
}

function row(database: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row | undefined {
  return database.prepare(sql).get(...params) as Row | undefined;
}

export function publicUser(value: Row): User {
  return {
    id: String(value.id),
    name: String(value.name),
    email: String(value.email),
    role: value.role as User["role"],
  };
}

export function findUserByEmail(database: DatabaseSync, email: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE email = ? COLLATE NOCASE", email);
}

export function findUserById(database: DatabaseSync, id: string): Row | undefined {
  return row(database, "SELECT * FROM users WHERE id = ?", id);
}

export function userCount(database: DatabaseSync): number {
  return Number(row(database, "SELECT COUNT(*) AS count FROM users")?.count ?? 0);
}

export function projectIdForUser(database: DatabaseSync, userId: string): string | null {
  const value = row(
    database,
    "SELECT project_id FROM project_members WHERE user_id = ? ORDER BY created_at LIMIT 1",
    userId,
  );
  return value ? String(value.project_id) : null;
}

export function getBoard(database: DatabaseSync, cardStore: MarkdownCardStore, user: User): BoardWorkspace | null {
  const projectId = projectIdForUser(database, user.id);
  if (!projectId) return null;
  const project = row(database, "SELECT id, name, slug FROM projects WHERE id = ?", projectId);
  if (!project) return null;

  const members = membersForProject(database, projectId);

  return {
    project: { id: String(project.id), name: String(project.name) },
    currentUser: user,
    members,
    cards: cardStore.list(String(project.slug)).map((card) => publicCard(card, members)),
  };
}

type CardInput = {
  title: string;
  description?: string;
  status?: CardStatus;
  assigneeId?: string | null;
};

export function createCard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  creatorId: string,
  input: CardInput,
): Card | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (!project || !creator || (input.assigneeId && !assignee)) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "backlog";
  const position = cardStore.list(String(project.slug)).filter((card) => card.status === status).length;
  const card: StoredCard = {
    id,
    title: input.title,
    description: input.description ?? "",
    status,
    position,
    assignee: assignee?.email.toLowerCase() ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  cardStore.save(String(project.slug), card);
  return publicCard(card, members);
}

export function updateCard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  cardId: string,
  input: Partial<CardInput> & { position?: number },
): Card | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const members = membersForProject(database, projectId);
  const cards = cardStore.list(projectSlug);
  const current = cards.find((card) => card.id === cardId);
  if (!current) return null;
  const assignee = input.assigneeId ? members.find((member) => member.id === input.assigneeId) : null;
  if (input.assigneeId && !assignee) return null;

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();
  const updated: StoredCard = {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    status: nextStatus,
    assignee: input.assigneeId === undefined ? current.assignee : assignee?.email.toLowerCase() ?? null,
    updatedAt: now,
  };

  if (!shouldMove) {
    cardStore.save(projectSlug, updated);
    return publicCard(updated, members);
  }

  for (const status of CARD_STATUSES) {
    const ordered = cards.filter((card) => card.id !== cardId && card.status === status);
    if (status === nextStatus) {
      const requestedPosition = input.position ?? ordered.length;
      ordered.splice(Math.max(0, Math.min(requestedPosition, ordered.length)), 0, updated);
    }
    ordered.forEach((card, position) => {
      const positioned = { ...card, position };
      if (card.id === cardId || card.position !== position) cardStore.save(projectSlug, positioned);
      if (card.id === cardId) updated.position = position;
    });
  }
  return publicCard(updated, members);
}

export function archiveCard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  cardId: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const projectSlug = String(project.slug);
  const current = cardStore.get(projectSlug, cardId);
  if (!current) return false;
  const now = new Date().toISOString();
  cardStore.archive(projectSlug, { ...current, archivedAt: now, updatedAt: now });
  cardStore
    .list(projectSlug)
    .filter((card) => card.status === current.status)
    .forEach((card, position) => {
      if (card.position !== position) cardStore.save(projectSlug, { ...card, position });
    });
  return true;
}

export function projectById(database: DatabaseSync, projectId: string): Row | undefined {
  return row(database, "SELECT id, name, slug FROM projects WHERE id = ?", projectId);
}

export function membersForProject(database: DatabaseSync, projectId: string): Member[] {
  return rows(
    database,
    `SELECT users.id, users.name, users.email, users.role, project_members.role AS project_role
     FROM project_members JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? ORDER BY project_members.created_at`,
    projectId,
  ).map(
    (value): Member => ({
      ...publicUser(value),
      projectRole: value.project_role as Member["projectRole"],
    }),
  );
}

function publicCard(value: StoredCard, members: Member[]): Card {
  const assignee = value.assignee
    ? members.find((member) => member.email.toLowerCase() === value.assignee?.toLowerCase())
    : null;
  const creator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
  if (value.assignee && !assignee) throw new Error(`Card ${value.id} references a non-member assignee`);
  if (!creator) throw new Error(`Card ${value.id} references a non-member creator`);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    status: value.status,
    position: value.position,
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    createdById: creator.id,
    createdByName: creator.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
