import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DiscussionMessage, DiscussionThread } from "../shared/types";

/**
 * The conversation that happens beside a page, kept apart from the record of what happened to it.
 *
 * A page already carries a history: the derived, muted trail of what the system observed. It is
 * written about you and belongs to nobody. A discussion message is the opposite on every axis -
 * somebody wrote it, it is addressed to somebody, and it is finished once it has been answered.
 * Fusing the two would bury a question under the column moves around it, and the one thing a
 * question has to communicate is whose turn it is.
 *
 * So threads live here, in their own table, with exactly one piece of state: open or answered.
 * That state is what keeps the surface small. Nothing is ever edited or deleted - answered
 * threads fold away, and the page stays short no matter how much has been said on it.
 */

type Row = Record<string, string | number | null>;

/** Who wrote something, resolved the way the activity log resolves it. */
function message(value: Row): DiscussionMessage {
  return {
    id: String(value.id),
    authorId: value.author_id === null ? null : String(value.author_id),
    /*
     * The live account name wins when the account still exists, so renaming yourself stays
     * consistent across everything you have ever said. The stored name is the fallback for an
     * author who has since been removed, which is why it is written down at all.
     */
    authorName: String(value.current_author_name ?? value.author_name),
    agentName: value.agent_name === null || value.agent_name === undefined ? null : String(value.agent_name),
    body: String(value.body),
    createdAt: String(value.created_at),
  };
}

const SELECT_MESSAGES = `SELECT page_discussion.*,
         authors.name AS current_author_name,
         answerers.name AS answered_by_name,
         agent_tokens.name AS agent_name
  FROM page_discussion
  LEFT JOIN users AS authors ON authors.id = page_discussion.author_id
  LEFT JOIN users AS answerers ON answerers.id = page_discussion.answered_by
  LEFT JOIN agent_tokens ON agent_tokens.id = page_discussion.agent_token_id
  WHERE page_discussion.project_id = ? AND page_discussion.page_id = ?
  ORDER BY page_discussion.created_at ASC, page_discussion.rowid ASC`;

/**
 * Every thread on one page, oldest first, each with its replies already attached.
 *
 * Ordering is by written time and then by insert order, so two messages that land in the same
 * millisecond still come back in the order they were actually written rather than whichever
 * order SQLite feels like today.
 */
export function listDiscussion(database: DatabaseSync, projectId: string, pageId: string): DiscussionThread[] {
  const values = database.prepare(SELECT_MESSAGES).all(projectId, pageId) as Row[];
  const threads = new Map<string, DiscussionThread>();
  for (const value of values) {
    if (value.parent_id !== null) continue;
    threads.set(String(value.id), {
      ...message(value),
      replies: [],
      answeredAt: value.answered_at === null ? null : String(value.answered_at),
      answeredById: value.answered_by === null ? null : String(value.answered_by),
      answeredByName: value.answered_by_name === null || value.answered_by_name === undefined
        ? null
        : String(value.answered_by_name),
    });
  }
  for (const value of values) {
    if (value.parent_id === null) continue;
    // A reply whose thread is gone is unreachable rather than an error; the cascade means it
    // cannot normally happen, and a half-read page is worse than a missing line.
    threads.get(String(value.parent_id))?.replies.push(message(value));
  }
  return [...threads.values()];
}

/** One thread and its replies, or null when nothing on this page has that id. */
export function findThread(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  threadId: string,
): DiscussionThread | null {
  return listDiscussion(database, projectId, pageId).find((thread) => thread.id === threadId) ?? null;
}

/**
 * How many threads are still waiting for an answer, per page, across a whole project.
 *
 * One query for the whole board rather than one per tile: this is read on every board load,
 * and a project carrying a few hundred pages should not pay a round trip each.
 */
export function openThreadCounts(database: DatabaseSync, projectId: string): Map<string, number> {
  const values = database
    .prepare(
      `SELECT page_id, COUNT(*) AS open FROM page_discussion
       WHERE project_id = ? AND parent_id IS NULL AND answered_at IS NULL
       GROUP BY page_id`,
    )
    .all(projectId) as Row[];
  return new Map(values.map((value) => [String(value.page_id), Number(value.open)]));
}

/** The same count for one page, for a read that did not gather the whole board. */
export function openThreadCount(database: DatabaseSync, projectId: string, pageId: string): number {
  const value = database
    .prepare(
      `SELECT COUNT(*) AS open FROM page_discussion
       WHERE project_id = ? AND page_id = ? AND parent_id IS NULL AND answered_at IS NULL`,
    )
    .get(projectId, pageId) as Row | undefined;
  return Number(value?.open ?? 0);
}

export type WriteAuthor = {
  id: string;
  name: string;
  /** The credential that wrote this, when an agent did. The person stays the author. */
  agentTokenId?: string | null;
};

/** Opens a thread. Returns it as everyone else will read it. */
export function openThread(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  author: WriteAuthor,
  body: string,
): DiscussionThread {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO page_discussion (id, project_id, page_id, parent_id, author_id, author_name, agent_token_id, body, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, pageId, author.id, author.name, author.agentTokenId ?? null, body, new Date().toISOString());
  return findThread(database, projectId, pageId, id) as DiscussionThread;
}

export type ReplyResult = DiscussionThread | "no_thread";

/**
 * Answers a thread in words.
 *
 * Replying does not close anything. Saying something and having said enough are different
 * claims, and only the second one is a thread's state - otherwise "answered" quietly decays
 * into "somebody responded", which is the failure this whole feature exists to avoid.
 */
export function replyToThread(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  threadId: string,
  author: WriteAuthor,
  body: string,
): ReplyResult {
  const thread = findThread(database, projectId, pageId, threadId);
  if (!thread) return "no_thread";
  database
    .prepare(
      `INSERT INTO page_discussion (id, project_id, page_id, parent_id, author_id, author_name, agent_token_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      projectId,
      pageId,
      threadId,
      author.id,
      author.name,
      author.agentTokenId ?? null,
      body,
      new Date().toISOString(),
    );
  return findThread(database, projectId, pageId, threadId) as DiscussionThread;
}

export type AnswerResult = DiscussionThread | "no_thread" | "unchanged";

/**
 * Marks a thread answered, or opens it back up.
 *
 * Reopening exists because closing is a judgement and judgements are wrong sometimes. It costs
 * one click and leaves a line in the history, which is the right price: cheap to correct, never
 * silent.
 */
export function setThreadAnswered(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  threadId: string,
  answered: boolean,
  userId: string,
): AnswerResult {
  const thread = findThread(database, projectId, pageId, threadId);
  if (!thread) return "no_thread";
  if ((thread.answeredAt !== null) === answered) return "unchanged";
  database
    .prepare("UPDATE page_discussion SET answered_at = ?, answered_by = ? WHERE id = ? AND parent_id IS NULL")
    .run(answered ? new Date().toISOString() : null, answered ? userId : null, threadId);
  return findThread(database, projectId, pageId, threadId) as DiscussionThread;
}

/**
 * Who is waiting on an open thread, for the relay that has to name somebody.
 *
 * The rule is that the turn belongs to whoever did not speak last: a thread nobody has replied
 * to is waiting on the page's assignee, and one that has been replied to is waiting on whoever
 * asked. An unassigned page with an unanswered question is waiting on nobody, and says so by
 * returning null rather than picking a person to bother.
 */
export function awaitingReplyFrom(thread: DiscussionThread, assigneeId: string | null): string | null {
  const last = thread.replies.at(-1) ?? thread;
  if (last.authorId === thread.authorId) return assigneeId === thread.authorId ? null : assigneeId;
  return thread.authorId;
}
