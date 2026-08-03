import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BoardWorkspace, Card, CardStatus, Member, User } from "../shared/types";

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

export function getBoard(database: DatabaseSync, user: User): BoardWorkspace | null {
  const projectId = projectIdForUser(database, user.id);
  if (!projectId) return null;
  const project = row(database, "SELECT id, name FROM projects WHERE id = ?", projectId);
  if (!project) return null;

  const members = rows(
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

  return {
    project: { id: String(project.id), name: String(project.name) },
    currentUser: user,
    members,
    cards: rows(
      database,
      `SELECT cards.*, assignee.name AS assignee_name, creator.name AS creator_name
       FROM cards
       LEFT JOIN users assignee ON assignee.id = cards.assignee_id
       JOIN users creator ON creator.id = cards.created_by
       WHERE cards.project_id = ? AND cards.archived_at IS NULL
       ORDER BY CASE cards.status
         WHEN 'backlog' THEN 0 WHEN 'ready' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
         cards.position, cards.created_at`,
      projectId,
    ).map(mapCard),
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
  projectId: string,
  creatorId: string,
  input: CardInput,
): Card | null {
  if (input.assigneeId !== undefined && input.assigneeId !== null && !isProjectMember(database, projectId, input.assigneeId)) {
    return null;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "backlog";
  const position = nextPosition(database, projectId, status);
  database
    .prepare(
      `INSERT INTO cards (
        id, project_id, title, description, status, position, assignee_id, created_by, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      projectId,
      input.title,
      input.description ?? "",
      status,
      position,
      input.assigneeId ?? null,
      creatorId,
      now,
      now,
    );
  return getCard(database, projectId, id);
}

export function updateCard(
  database: DatabaseSync,
  projectId: string,
  cardId: string,
  input: Partial<CardInput> & { position?: number },
): Card | null {
  const current = getCard(database, projectId, cardId);
  if (!current) return null;
  if (input.assigneeId !== undefined && input.assigneeId !== null && !isProjectMember(database, projectId, input.assigneeId)) {
    return null;
  }

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    let position = current.position;
    if (shouldMove) {
      database.prepare("UPDATE cards SET position = -1 WHERE id = ?").run(cardId);
      database
        .prepare(
          `UPDATE cards SET position = position - 1
           WHERE project_id = ? AND status = ? AND archived_at IS NULL AND position > ?`,
        )
        .run(projectId, current.status, current.position);
      const available = Number(
        row(
          database,
          "SELECT COUNT(*) AS count FROM cards WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?",
          projectId,
          nextStatus,
          cardId,
        )?.count ?? 0,
      );
      position = Math.max(0, Math.min(input.position ?? available, available));
      database
        .prepare(
          `UPDATE cards SET position = position + 1
           WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ? AND position >= ?`,
        )
        .run(projectId, nextStatus, cardId, position);
    }

    database
      .prepare(
        `UPDATE cards SET title = ?, description = ?, status = ?, position = ?, assignee_id = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        input.title ?? current.title,
        input.description ?? current.description,
        nextStatus,
        position,
        input.assigneeId === undefined ? current.assigneeId : input.assigneeId,
        now,
        cardId,
        projectId,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getCard(database, projectId, cardId);
}

export function archiveCard(database: DatabaseSync, projectId: string, cardId: string): boolean {
  const current = getCard(database, projectId, cardId);
  if (!current) return false;
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, cardId);
    database
      .prepare(
        `UPDATE cards SET position = position - 1
         WHERE project_id = ? AND status = ? AND archived_at IS NULL AND position > ?`,
      )
      .run(projectId, current.status, current.position);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}

function getCard(database: DatabaseSync, projectId: string, cardId: string): Card | null {
  const value = row(
    database,
    `SELECT cards.*, assignee.name AS assignee_name, creator.name AS creator_name
     FROM cards
     LEFT JOIN users assignee ON assignee.id = cards.assignee_id
     JOIN users creator ON creator.id = cards.created_by
     WHERE cards.id = ? AND cards.project_id = ? AND cards.archived_at IS NULL`,
    cardId,
    projectId,
  );
  return value ? mapCard(value) : null;
}

function mapCard(value: Row): Card {
  return {
    id: String(value.id),
    title: String(value.title),
    description: String(value.description),
    status: value.status as CardStatus,
    position: Number(value.position),
    assigneeId: value.assignee_id ? String(value.assignee_id) : null,
    assigneeName: value.assignee_name ? String(value.assignee_name) : null,
    createdById: String(value.created_by),
    createdByName: String(value.creator_name),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function isProjectMember(database: DatabaseSync, projectId: string, userId: string): boolean {
  return Boolean(
    row(database, "SELECT 1 AS found FROM project_members WHERE project_id = ? AND user_id = ?", projectId, userId),
  );
}

function nextPosition(database: DatabaseSync, projectId: string, status: CardStatus): number {
  return Number(
    row(
      database,
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE project_id = ? AND status = ? AND archived_at IS NULL",
      projectId,
      status,
    )?.next ?? 0,
  );
}
