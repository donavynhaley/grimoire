import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  Asset,
  Build,
  Comment,
  Idea,
  Member,
  Milestone,
  Outcome,
  Pillar,
  Playtest,
  Project,
  User,
  WorkItem,
  Workspace,
} from "../shared/types";

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
  const result = row(
    database,
    "SELECT project_id FROM project_members WHERE user_id = ? ORDER BY created_at LIMIT 1",
    userId,
  );
  return result ? String(result.project_id) : null;
}

export function recordActivity(
  database: DatabaseSync,
  projectId: string,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  summary: string,
): void {
  database
    .prepare(
      "INSERT INTO activity (id, project_id, actor_id, action, entity_type, entity_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), projectId, actorId, action, entityType, entityId, summary, new Date().toISOString());
}

export function createIdea(
  database: DatabaseSync,
  projectId: string,
  creatorId: string,
  input: { title: string; notes?: string; horizon?: string },
): Idea {
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO ideas (id, project_id, title, notes, status, horizon, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?)",
    )
    .run(id, projectId, input.title, input.notes ?? "", input.horizon ?? "later", creatorId, now, now);
  recordActivity(database, projectId, creatorId, "created", "idea", id, input.title);
  return getIdea(database, id)!;
}

export function getIdea(database: DatabaseSync, id: string): Idea | null {
  const value = row(
    database,
    `SELECT ideas.*, users.name AS creator_name
     FROM ideas JOIN users ON users.id = ideas.created_by WHERE ideas.id = ?`,
    id,
  );
  return value ? mapIdea(value) : null;
}

export function getWorkspace(database: DatabaseSync, user: User): Workspace | null {
  const projectId = projectIdForUser(database, user.id);
  if (!projectId) return null;

  const projectRow = row(database, "SELECT * FROM projects WHERE id = ?", projectId);
  if (!projectRow) return null;

  const project: Project = {
    id: String(projectRow.id),
    name: String(projectRow.name),
    slug: String(projectRow.slug),
    pitch: String(projectRow.pitch),
    playerFantasy: String(projectRow.player_fantasy),
    currentDirection: String(projectRow.current_direction),
    directionDetail: String(projectRow.direction_detail),
    nonGoals: String(projectRow.non_goals),
  };

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

  const pillars = rows(
    database,
    "SELECT * FROM pillars WHERE project_id = ? ORDER BY position, title",
    projectId,
  ).map(
    (value): Pillar => ({
      id: String(value.id),
      title: String(value.title),
      description: String(value.description),
      position: Number(value.position),
    }),
  );

  const milestones = rows(
    database,
    "SELECT * FROM milestones WHERE project_id = ? ORDER BY position, created_at",
    projectId,
  ).map(
    (value): Milestone => ({
      id: String(value.id),
      title: String(value.title),
      description: String(value.description),
      status: value.status as Milestone["status"],
      position: Number(value.position),
      conditions: rows(
        database,
        "SELECT * FROM milestone_conditions WHERE milestone_id = ? ORDER BY position",
        String(value.id),
      ).map((condition) => ({
        id: String(condition.id),
        title: String(condition.title),
        complete: Boolean(condition.complete),
        position: Number(condition.position),
      })),
    }),
  );

  const ideas = rows(
    database,
    `SELECT ideas.*, users.name AS creator_name
     FROM ideas JOIN users ON users.id = ideas.created_by
     WHERE ideas.project_id = ? ORDER BY ideas.created_at DESC`,
    projectId,
  ).map(mapIdea);

  const outcomes = rows(
    database,
    `SELECT outcomes.*, users.name AS owner_name
     FROM outcomes LEFT JOIN users ON users.id = outcomes.owner_id
     WHERE outcomes.project_id = ? ORDER BY outcomes.created_at DESC`,
    projectId,
  ).map(
    (value): Outcome => ({
      id: String(value.id),
      title: String(value.title),
      description: String(value.description),
      status: value.status as Outcome["status"],
      ownerId: value.owner_id ? String(value.owner_id) : null,
      ownerName: value.owner_name ? String(value.owner_name) : null,
      milestoneId: value.milestone_id ? String(value.milestone_id) : null,
      pillarId: value.pillar_id ? String(value.pillar_id) : null,
      definitionOfPlayable: String(value.definition_of_playable),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    }),
  );

  const dependencyRows = rows(
    database,
    `SELECT work_dependencies.* FROM work_dependencies
     JOIN work_items ON work_items.id = work_dependencies.work_item_id
     WHERE work_items.project_id = ?`,
    projectId,
  );
  const dependencies = new Map<string, string[]>();
  for (const dependency of dependencyRows) {
    const id = String(dependency.work_item_id);
    dependencies.set(id, [...(dependencies.get(id) ?? []), String(dependency.depends_on_id)]);
  }

  const workItems = rows(
    database,
    `SELECT work_items.*, users.name AS owner_name
     FROM work_items LEFT JOIN users ON users.id = work_items.owner_id
     WHERE work_items.project_id = ? ORDER BY work_items.position, work_items.created_at`,
    projectId,
  ).map(
    (value): WorkItem => ({
      id: String(value.id),
      outcomeId: String(value.outcome_id),
      title: String(value.title),
      discipline: String(value.discipline),
      status: value.status as WorkItem["status"],
      ownerId: value.owner_id ? String(value.owner_id) : null,
      ownerName: value.owner_name ? String(value.owner_name) : null,
      description: String(value.description),
      position: Number(value.position),
      dependencyIds: dependencies.get(String(value.id)) ?? [],
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    }),
  );

  const assets = rows(
    database,
    `SELECT assets.*, users.name AS owner_name
     FROM assets LEFT JOIN users ON users.id = assets.owner_id
     WHERE assets.project_id = ? ORDER BY assets.created_at DESC`,
    projectId,
  ).map(
    (value): Asset => ({
      id: String(value.id),
      outcomeId: value.outcome_id ? String(value.outcome_id) : null,
      name: String(value.name),
      type: String(value.type),
      status: String(value.status),
      ownerId: value.owner_id ? String(value.owner_id) : null,
      ownerName: value.owner_name ? String(value.owner_name) : null,
      sourceUrl: String(value.source_url),
      notes: String(value.notes),
      stages: rows(
        database,
        `SELECT asset_stages.*, users.name AS owner_name FROM asset_stages
         LEFT JOIN users ON users.id = asset_stages.owner_id
         WHERE asset_stages.asset_id = ? ORDER BY asset_stages.position`,
        String(value.id),
      ).map((stage) => ({
        id: String(stage.id),
        label: String(stage.label),
        status: stage.status as Asset["stages"][number]["status"],
        ownerId: stage.owner_id ? String(stage.owner_id) : null,
        ownerName: stage.owner_name ? String(stage.owner_name) : null,
        position: Number(stage.position),
        handoffNote: String(stage.handoff_note),
      })),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    }),
  );

  const builds = rows(
    database,
    `SELECT builds.*, users.name AS creator_name FROM builds
     JOIN users ON users.id = builds.created_by WHERE builds.project_id = ? ORDER BY built_at DESC`,
    projectId,
  ).map(
    (value): Build => ({
      id: String(value.id),
      name: String(value.name),
      summary: String(value.summary),
      knownIssues: String(value.known_issues),
      creatorName: String(value.creator_name),
      builtAt: String(value.built_at),
    }),
  );

  const playtests = rows(
    database,
    `SELECT playtests.*, users.name AS creator_name FROM playtests
     JOIN users ON users.id = playtests.created_by
     WHERE playtests.project_id = ? ORDER BY played_at DESC`,
    projectId,
  ).map(
    (value): Playtest => ({
      id: String(value.id),
      outcomeId: value.outcome_id ? String(value.outcome_id) : null,
      buildId: value.build_id ? String(value.build_id) : null,
      title: String(value.title),
      observations: String(value.observations),
      decision: value.decision as Playtest["decision"],
      creatorName: String(value.creator_name),
      playedAt: String(value.played_at),
    }),
  );

  const comments = rows(
    database,
    `SELECT comments.*, users.name AS author_name FROM comments
     JOIN users ON users.id = comments.author_id
     WHERE comments.project_id = ? ORDER BY created_at DESC`,
    projectId,
  ).map(
    (value): Comment => ({
      id: String(value.id),
      entityType: String(value.entity_type),
      entityId: String(value.entity_id),
      body: String(value.body),
      authorName: String(value.author_name),
      createdAt: String(value.created_at),
    }),
  );

  const activity = rows(
    database,
    `SELECT activity.*, users.name AS actor_name FROM activity
     JOIN users ON users.id = activity.actor_id
     WHERE activity.project_id = ? ORDER BY created_at DESC LIMIT 50`,
    projectId,
  ).map(
    (value): Activity => ({
      id: String(value.id),
      actorName: String(value.actor_name),
      action: String(value.action),
      entityType: String(value.entity_type),
      entityId: String(value.entity_id),
      summary: String(value.summary),
      createdAt: String(value.created_at),
    }),
  );

  return {
    project,
    currentUser: user,
    members,
    pillars,
    milestones,
    ideas,
    outcomes,
    workItems,
    assets,
    builds,
    playtests,
    comments,
    activity,
  };
}

function mapIdea(value: Row): Idea {
  return {
    id: String(value.id),
    title: String(value.title),
    notes: String(value.notes),
    status: value.status as Idea["status"],
    horizon: value.horizon as Idea["horizon"],
    creatorId: String(value.created_by),
    creatorName: String(value.creator_name),
    promotedOutcomeId: value.promoted_outcome_id ? String(value.promoted_outcome_id) : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

