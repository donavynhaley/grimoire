import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CARD_STATUSES,
  type BoardWorkspace,
  type Card,
  type CardCategory,
  type CardStatus,
  type Member,
  type ProjectCategory,
  type ProjectSummary,
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

export function defaultProjectIdForUser(database: DatabaseSync, user: User): string | null {
  const value =
    user.role === "owner"
      ? row(database, "SELECT id AS project_id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1")
      : row(
        database,
        `SELECT project_members.project_id FROM project_members
         JOIN projects ON projects.id = project_members.project_id
         WHERE project_members.user_id = ? AND projects.archived_at IS NULL
         ORDER BY project_members.created_at LIMIT 1`,
        user.id,
      );
  return value ? String(value.project_id) : null;
}

export function projectSlug(database: DatabaseSync, projectId: string): string | null {
  const project = row(database, "SELECT slug FROM projects WHERE id = ?", projectId);
  return project ? String(project.slug) : null;
}

export function userCanAccessProject(database: DatabaseSync, user: User, projectId: string): boolean {
  if (user.role === "owner") {
    return Boolean(row(database, "SELECT 1 AS ok FROM projects WHERE id = ? AND archived_at IS NULL", projectId));
  }
  return Boolean(
    row(
      database,
      `SELECT 1 AS ok FROM project_members
       JOIN projects ON projects.id = project_members.project_id
       WHERE project_members.project_id = ? AND project_members.user_id = ? AND projects.archived_at IS NULL`,
      projectId,
      user.id,
    ),
  );
}

export function listProjectsForUser(database: DatabaseSync, user: User): ProjectSummary[] {
  const values =
    user.role === "owner"
      ? rows(database, "SELECT id, name FROM projects WHERE archived_at IS NULL ORDER BY created_at")
      : rows(
        database,
        `SELECT projects.id, projects.name FROM project_members
         JOIN projects ON projects.id = project_members.project_id
         WHERE project_members.user_id = ? AND projects.archived_at IS NULL
         ORDER BY project_members.created_at`,
        user.id,
      );
  return values.map((value) => ({ id: String(value.id), name: String(value.name) }));
}

export function renameProject(database: DatabaseSync, projectId: string, name: string): boolean {
  const result = database
    .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(name, new Date().toISOString(), projectId);
  return Number(result.changes) === 1;
}

export type ArchiveProjectResult = "archived" | "not_found" | "last_project";

export function archiveProject(database: DatabaseSync, projectId: string): ArchiveProjectResult {
  const active = rows(database, "SELECT id FROM projects WHERE archived_at IS NULL");
  if (!active.some((value) => String(value.id) === projectId)) return "not_found";
  if (active.length === 1) return "last_project";
  database
    .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), projectId);
  return "archived";
}

export function categoriesForProject(database: DatabaseSync, projectId: string): ProjectCategory[] {
  return rows(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? ORDER BY position, created_at",
    projectId,
  ).map((value) => ({
    slug: String(value.slug),
    name: String(value.name),
    color: String(value.color),
    position: Number(value.position),
  }));
}

export function categorySlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export type CreateCategoryResult = { category: ProjectCategory } | "exists" | "invalid_name";

export function createCategory(
  database: DatabaseSync,
  projectId: string,
  input: { name: string; color: string },
): CreateCategoryResult {
  const slug = categorySlugFromName(input.name);
  if (!slug) return "invalid_name";
  if (row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    return "exists";
  }
  const position = categoriesForProject(database, projectId).length;
  database
    .prepare("INSERT INTO categories (project_id, slug, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(projectId, slug, input.name, input.color, position, new Date().toISOString());
  return { category: { slug, name: input.name, color: input.color, position } };
}

export function updateCategory(
  database: DatabaseSync,
  projectId: string,
  slug: string,
  input: { name?: string; color?: string },
): ProjectCategory | null {
  const current = row(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? AND slug = ?",
    projectId,
    slug,
  );
  if (!current) return null;
  const name = input.name ?? String(current.name);
  const color = input.color ?? String(current.color);
  database
    .prepare("UPDATE categories SET name = ?, color = ? WHERE project_id = ? AND slug = ?")
    .run(name, color, projectId, slug);
  return { slug, name, color, position: Number(current.position) };
}

export function deleteCategory(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  slug: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const removed = database
    .prepare("DELETE FROM categories WHERE project_id = ? AND slug = ?")
    .run(projectId, slug);
  if (Number(removed.changes) !== 1) return false;
  const now = new Date().toISOString();
  cardStore.list(String(project.slug)).forEach((card) => {
    if (card.category !== slug) return;
    cardStore.save(String(project.slug), { ...card, category: null, updatedAt: now });
  });
  return true;
}

export function getBoard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  user: User,
  projectId: string,
): BoardWorkspace | null {
  const project = row(database, "SELECT id, name, slug FROM projects WHERE id = ?", projectId);
  if (!project) return null;

  const members = membersForProject(database, projectId);
  const cards = cardStore.list(String(project.slug));
  validateDependencyGraph(cards);

  return {
    project: { id: String(project.id), name: String(project.name) },
    projects: listProjectsForUser(database, user),
    categories: categoriesForProject(database, projectId),
    currentUser: user,
    members,
    cards: cards.map((card) => publicCard(database, card, members)),
  };
}

/** Reads one card in the same shape the board serves, for before-and-after comparisons. */
export function findCard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  cardId: string,
): Card | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const stored = cardStore.get(String(project.slug), cardId);
  return stored ? publicCard(database, stored, membersForProject(database, projectId)) : null;
}

export function listCards(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
): Card[] {
  const project = projectById(database, projectId);
  if (!project) return [];
  const members = membersForProject(database, projectId);
  return cardStore.list(String(project.slug)).map((card) => publicCard(database, card, members));
}

type CardInput = {
  title: string;
  description?: string;
  category?: CardCategory | null;
  blockedBy?: string[];
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
  if (input.category) requireProjectCategory(database, projectId, input.category);
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "backlog";
  const cards = cardStore.list(String(project.slug));
  const position = cards.filter((card) => card.status === status).length;
  const card: StoredCard = {
    id,
    title: input.title,
    description: input.description ?? "",
    category: input.category ?? null,
    blockedBy: input.blockedBy ?? [],
    unblockedCards: [],
    status,
    position,
    assignee: assignee?.email.toLowerCase() ?? null,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
    archivedAt: null,
  };
  validateDependencyGraph([...cards, card]);
  cardStore.save(String(project.slug), card);
  return publicCard(database, card, members);
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
  if (input.category) requireProjectCategory(database, projectId, input.category);

  const nextStatus = input.status ?? current.status;
  const shouldMove = input.status !== undefined || input.position !== undefined;
  const now = new Date().toISOString();
  const completedAt = nextStatus === "done"
    ? current.status === "done" ? current.completedAt ?? current.updatedAt : now
    : null;
  const updated: StoredCard = {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    category: input.category === undefined ? current.category : input.category,
    blockedBy: input.blockedBy ?? current.blockedBy,
    status: nextStatus,
    assignee: input.assigneeId === undefined ? current.assignee : assignee?.email.toLowerCase() ?? null,
    updatedAt: now,
    completedAt,
  };
  validateDependencyGraph(cards.map((card) => card.id === cardId ? updated : card));

  if (!shouldMove) {
    cardStore.save(projectSlug, updated);
    return publicCard(database, updated, members);
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
  return publicCard(database, updated, members);
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
  const cards = cardStore.list(projectSlug);
  const dependents = cards.filter((card) => card.id !== cardId && card.blockedBy.includes(cardId));
  if (current.status !== "done" && dependents.some((card) => card.status !== "done")) {
    throw new CardDependencyError("This card blocks active work and cannot be archived", 409);
  }
  const now = new Date().toISOString();
  dependents.forEach((card) => {
    cardStore.save(projectSlug, {
      ...card,
      blockedBy: card.blockedBy.filter((dependencyId) => dependencyId !== cardId),
      updatedAt: now,
    });
  });
  cardStore.archive(projectSlug, {
    ...current,
    unblockedCards: dependents.map((card) => card.id),
    archivedAt: now,
    updatedAt: now,
  });
  cardStore
    .list(projectSlug)
    .filter((card) => card.status === current.status)
    .forEach((card, position) => {
      if (card.position !== position) cardStore.save(projectSlug, { ...card, position });
    });
  return true;
}

export function restoreCard(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  cardId: string,
): Card | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const archived = cardStore.getArchived(projectSlug, cardId);
  if (!archived) return null;
  const cards = cardStore.list(projectSlug);
  const restored: StoredCard = {
    ...archived,
    unblockedCards: [],
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  const previouslyBlocked = new Set(archived.unblockedCards);
  const restoredCards = cards.map((card) => previouslyBlocked.has(card.id)
    ? { ...card, blockedBy: [...card.blockedBy, restored.id], updatedAt: restored.updatedAt }
    : card);
  validateDependencyGraph([...restoredCards, restored]);
  cardStore.restore(projectSlug, restored);

  restoredCards.forEach((card) => {
    const previous = cards.find((candidate) => candidate.id === card.id);
    if (previous && previous.blockedBy.length !== card.blockedBy.length) cardStore.save(projectSlug, card);
  });

  const ordered = restoredCards.filter((card) => card.status === restored.status);
  ordered.splice(Math.max(0, Math.min(restored.position, ordered.length)), 0, restored);
  ordered.forEach((card, position) => {
    if (card.position !== position) cardStore.save(projectSlug, { ...card, position });
    if (card.id === restored.id) restored.position = position;
  });
  return publicCard(database, restored, membersForProject(database, projectId));
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

export type RemoveMemberResult = "removed" | "not_found" | "owner";

export function removeProjectMember(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  projectId: string,
  memberId: string,
): RemoveMemberResult {
  const project = projectById(database, projectId);
  const member = membersForProject(database, projectId).find((candidate) => candidate.id === memberId);
  if (!project || !member) return "not_found";
  if (member.projectRole === "owner") return "owner";

  const now = new Date().toISOString();
  cardStore.list(String(project.slug)).forEach((card) => {
    if (card.assignee?.toLowerCase() !== member.email.toLowerCase()) return;
    cardStore.save(String(project.slug), { ...card, assignee: null, updatedAt: now });
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    const removed = database
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'")
      .run(projectId, memberId);
    if (Number(removed.changes) !== 1) throw new Error("Project membership changed while it was being removed");
    const remaining = row(database, "SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?", memberId);
    if (Number(remaining?.count ?? 0) === 0) {
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(memberId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return "removed";
}

function publicCard(database: DatabaseSync, value: StoredCard, members: Member[]): Card {
  const assignee = value.assignee
    ? members.find((member) => member.email.toLowerCase() === value.assignee?.toLowerCase())
    : null;
  const currentCreator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
  const historicalCreator = currentCreator ?? findUserByEmail(database, value.createdBy);
  if (value.assignee && !assignee) throw new Error(`Card ${value.id} references a non-member assignee`);
  if (!historicalCreator) throw new Error(`Card ${value.id} references an unknown creator`);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    category: value.category,
    blockedBy: value.blockedBy,
    status: value.status,
    position: value.position,
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    createdById: String(historicalCreator.id),
    createdByName: String(historicalCreator.name),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  };
}

export class CardDependencyError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
  }
}

function requireProjectCategory(database: DatabaseSync, projectId: string, slug: string): void {
  if (!row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    throw new CardDependencyError("This category is not part of the project", 400);
  }
}

function validateDependencyGraph(cards: StoredCard[]): void {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  for (const card of cards) {
    if (new Set(card.blockedBy).size !== card.blockedBy.length) {
      throw new CardDependencyError("A blocking card can only be linked once");
    }
    for (const dependencyId of card.blockedBy) {
      if (dependencyId === card.id) throw new CardDependencyError("A card cannot block itself");
      if (!cardsById.has(dependencyId)) throw new CardDependencyError("A blocking card could not be found");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (cardId: string) => {
    if (visiting.has(cardId)) throw new CardDependencyError("Card dependencies cannot form a cycle");
    if (visited.has(cardId)) return;
    visiting.add(cardId);
    for (const dependencyId of cardsById.get(cardId)?.blockedBy ?? []) visit(dependencyId);
    visiting.delete(cardId);
    visited.add(cardId);
  };
  for (const card of cards) visit(card.id);
}
