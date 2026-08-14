import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IDEA_STATES, type Card, type Idea, type IdeaState, type IdeaWorkspace, type User } from "../shared/types";
import { MarkdownCardStore } from "./markdown-cards";
import { MarkdownChapterStore } from "./markdown-chapters";
import { MarkdownIdeaStore, type StoredIdea } from "./markdown-ideas";
import { CardDependencyError, createCard, membersForProject, projectById, requireUnchangedContent } from "./repository";

type IdeaInput = {
  title: string;
  description?: string;
  state?: IdeaState;
};

export function getIdeas(
  database: DatabaseSync,
  ideaStore: MarkdownIdeaStore,
  user: User,
  projectId: string,
): IdeaWorkspace | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const members = membersForProject(database, projectId);
  return {
    project: { id: String(project.id), name: String(project.name) },
    currentUser: user,
    ideas: ideaStore.list(String(project.slug)).map((idea) => publicIdea(idea, members)),
  };
}

/** Reads one idea in the same shape the garden serves, for before-and-after comparisons. */
export function findIdea(
  database: DatabaseSync,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  ideaId: string,
): Idea | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const stored = ideaStore.get(String(project.slug), ideaId);
  return stored ? publicIdea(stored, membersForProject(database, projectId)) : null;
}

export function createIdea(
  database: DatabaseSync,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  creatorId: string,
  input: IdeaInput,
): Idea | null {
  const project = projectById(database, projectId);
  const members = membersForProject(database, projectId);
  const creator = members.find((member) => member.id === creatorId);
  if (!project || !creator) return null;
  const state = input.state ?? "inbox";
  const now = new Date().toISOString();
  const idea: StoredIdea = {
    id: randomUUID(),
    title: input.title,
    description: input.description ?? "",
    state,
    position: ideaStore.list(String(project.slug)).filter((candidate) => candidate.state === state).length,
    createdBy: creator.email.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    promotedTo: null,
    promotedAt: null,
  };
  ideaStore.save(String(project.slug), idea);
  return publicIdea(idea, members);
}

export function updateIdea(
  database: DatabaseSync,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  ideaId: string,
  input: Partial<IdeaInput> & { position?: number; expectedTitle?: string; expectedDescription?: string },
): Idea | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const members = membersForProject(database, projectId);
  const ideas = ideaStore.list(projectSlug);
  const current = ideas.find((idea) => idea.id === ideaId);
  if (!current || current.promotedTo) return null;
  requireUnchangedContent(current, input, publicIdea(current, members), "idea");
  const nextState = input.state ?? current.state;
  const shouldMove = input.state !== undefined || input.position !== undefined;
  const updated: StoredIdea = {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    state: nextState,
    updatedAt: new Date().toISOString(),
  };

  if (!shouldMove) {
    ideaStore.save(projectSlug, updated);
    return publicIdea(updated, members);
  }

  for (const state of IDEA_STATES) {
    const ordered = ideas.filter((idea) => idea.id !== ideaId && idea.state === state);
    if (state === nextState) {
      const requestedPosition = input.position ?? ordered.length;
      ordered.splice(Math.max(0, Math.min(requestedPosition, ordered.length)), 0, updated);
    }
    ordered.forEach((idea, position) => {
      const positioned = { ...idea, position };
      if (idea.id === ideaId || idea.position !== position) ideaStore.save(projectSlug, positioned);
      if (idea.id === ideaId) updated.position = position;
    });
  }
  return publicIdea(updated, members);
}

export function promoteIdea(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  chapterStore: MarkdownChapterStore,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  creatorId: string,
  ideaId: string,
): Card | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const idea = ideaStore.get(projectSlug, ideaId);
  if (!idea || idea.promotedTo) return null;
  // A promoted idea lands unchaptered. Deciding it is work is a separate act from deciding
  // when the work happens, and the Backlog is where that second decision gets made.
  const card = createCard(database, cardStore, chapterStore, projectId, creatorId, {
    title: idea.title,
    description: idea.description,
    status: "backlog",
  });
  if (!card) return null;
  const now = new Date().toISOString();
  ideaStore.archive(projectSlug, { ...idea, promotedTo: card.id, promotedAt: now, updatedAt: now });
  normalizeIdeaPositions(ideaStore, projectSlug, idea.state);
  return card;
}

export function undoPromotion(
  database: DatabaseSync,
  cardStore: MarkdownCardStore,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  ideaId: string,
): Idea | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const archived = ideaStore.getArchived(projectSlug, ideaId);
  if (!archived?.promotedTo) return null;
  const promotedCard = cardStore.get(projectSlug, archived.promotedTo);
  if (!promotedCard) return null;
  const cards = cardStore.list(projectSlug);
  if (
    promotedCard.updatedAt !== promotedCard.createdAt ||
    promotedCard.title !== archived.title ||
    promotedCard.description !== archived.description ||
    promotedCard.status !== "backlog" ||
    promotedCard.category !== null ||
    promotedCard.assignee !== null ||
    promotedCard.blockedBy.length > 0
  ) {
    throw new CardDependencyError("This work card has changed and its promotion cannot be undone", 409);
  }
  if (cards.some((card) => card.id !== promotedCard.id && card.blockedBy.includes(promotedCard.id))) {
    throw new CardDependencyError("This promoted card blocks other work and cannot be undone", 409);
  }

  cardStore.remove(projectSlug, promotedCard.id);
  cards
    .filter((card) => card.id !== promotedCard.id && card.status === promotedCard.status)
    .forEach((card, position) => {
      if (card.position !== position) cardStore.save(projectSlug, { ...card, position });
    });

  const restored: StoredIdea = {
    ...archived,
    promotedTo: null,
    promotedAt: null,
    updatedAt: new Date().toISOString(),
  };
  ideaStore.restore(projectSlug, restored);
  const ideas = ideaStore.list(projectSlug).filter((idea) => idea.id !== restored.id && idea.state === restored.state);
  ideas.splice(Math.max(0, Math.min(restored.position, ideas.length)), 0, restored);
  ideas.forEach((idea, position) => {
    if (idea.position !== position) ideaStore.save(projectSlug, { ...idea, position });
    if (idea.id === restored.id) restored.position = position;
  });
  return publicIdea(restored, membersForProject(database, projectId));
}

function normalizeIdeaPositions(ideaStore: MarkdownIdeaStore, projectSlug: string, state: IdeaState): void {
  ideaStore
    .list(projectSlug)
    .filter((idea) => idea.state === state)
    .forEach((idea, position) => {
      if (idea.position !== position) ideaStore.save(projectSlug, { ...idea, position });
    });
}

function publicIdea(value: StoredIdea, members: ReturnType<typeof membersForProject>): Idea {
  const creator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
  if (!creator) throw new Error(`Idea ${value.id} references a non-member creator`);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    state: value.state,
    position: value.position,
    createdById: creator.id,
    createdByName: creator.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
