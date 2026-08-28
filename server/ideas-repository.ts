import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { placeInOrder, renumber } from "./ordering";
import {
  IDEA_STATES,
  type Page,
  type Idea,
  type IdeaState,
  type IdeaWorkspace,
  type User,
} from "../shared/types";
import { MarkdownPageStore } from "./markdown-pages";
import { MarkdownChapterStore } from "./markdown-chapters";
import { MarkdownIdeaStore, type StoredIdea } from "./markdown-ideas";
import {
  PageDependencyError,
  createPage,
  membersForProject,
  projectById,
  requireUnchangedContent,
} from "./repository";

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
    const others = ideas.filter((idea) => idea.id !== ideaId && idea.state === state);
    const ordered =
      state === nextState ? placeInOrder(others, updated, input.position ?? others.length) : others;
    const settled = renumber(ordered, (idea) => ideaStore.save(projectSlug, idea), ideaId);
    if (settled >= 0) updated.position = settled;
  }
  return publicIdea(updated, members);
}

export function promoteIdea(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  chapterStore: MarkdownChapterStore,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  creatorId: string,
  ideaId: string,
): Page | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const idea = ideaStore.get(projectSlug, ideaId);
  if (!idea || idea.promotedTo) return null;
  // A promoted idea lands unchaptered. Deciding it is work is a separate act from deciding
  // when the work happens, and the Backlog is where that second decision gets made.
  const page = createPage(database, pageStore, chapterStore, projectId, creatorId, {
    title: idea.title,
    description: idea.description,
    status: "backlog",
  });
  if (!page) return null;
  const now = new Date().toISOString();
  ideaStore.archive(projectSlug, { ...idea, promotedTo: page.id, promotedAt: now, updatedAt: now });
  normalizeIdeaPositions(ideaStore, projectSlug, idea.state);
  return page;
}

export function undoPromotion(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  ideaStore: MarkdownIdeaStore,
  projectId: string,
  ideaId: string,
): Idea | null {
  const project = projectById(database, projectId);
  if (!project) return null;
  const projectSlug = String(project.slug);
  const archived = ideaStore.getArchived(projectSlug, ideaId);
  if (!archived?.promotedTo) return null;
  const promotedPage = pageStore.get(projectSlug, archived.promotedTo);
  if (!promotedPage) return null;
  const pages = pageStore.list(projectSlug);
  if (
    promotedPage.updatedAt !== promotedPage.createdAt ||
    promotedPage.title !== archived.title ||
    promotedPage.description !== archived.description ||
    promotedPage.status !== "backlog" ||
    promotedPage.category !== null ||
    promotedPage.assignee !== null ||
    promotedPage.blockedBy.length > 0
  ) {
    throw new PageDependencyError("This work page has changed and its promotion cannot be undone", 409);
  }
  if (pages.some((page) => page.id !== promotedPage.id && page.blockedBy.includes(promotedPage.id))) {
    throw new PageDependencyError("This promoted page blocks other work and cannot be undone", 409);
  }

  pageStore.remove(projectSlug, promotedPage.id);
  renumber(
    pages.filter((page) => page.id !== promotedPage.id && page.status === promotedPage.status),
    (page) => pageStore.save(projectSlug, page),
  );

  const restored: StoredIdea = {
    ...archived,
    promotedTo: null,
    promotedAt: null,
    updatedAt: new Date().toISOString(),
  };
  ideaStore.restore(projectSlug, restored);
  const ordered = placeInOrder(
    ideaStore.list(projectSlug).filter((idea) => idea.id !== restored.id && idea.state === restored.state),
    restored,
    restored.position,
  );
  renumber(ordered, (idea) => ideaStore.save(projectSlug, idea));
  restored.position = ordered.findIndex((idea) => idea.id === restored.id);
  return publicIdea(restored, membersForProject(database, projectId));
}

function normalizeIdeaPositions(ideaStore: MarkdownIdeaStore, projectSlug: string, state: IdeaState): void {
  renumber(
    ideaStore.list(projectSlug).filter((idea) => idea.state === state),
    (idea) => ideaStore.save(projectSlug, idea),
  );
}

function publicIdea(value: StoredIdea, members: ReturnType<typeof membersForProject>): Idea {
  // The same grace pages and chapters extend: a creator the project no longer
  // knows keeps their written email as a name rather than failing the garden.
  const creator = members.find((member) => member.email.toLowerCase() === value.createdBy.toLowerCase());
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    state: value.state,
    position: value.position,
    createdById: creator ? creator.id : "",
    createdByName: creator ? creator.name : value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
