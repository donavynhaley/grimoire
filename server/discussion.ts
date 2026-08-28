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

/** Somebody who can be named in a message. */
export type Mentionable = { id: string; name: string };

/**
 * Who a message named.
 *
 * Matched against the people on the project rather than parsed as a token, because a name has
 * spaces in it and no amount of regex decides where "@Maren Voss said" stops being a name.
 * Longest names go first, so naming "@Maren Voss" is not read as naming "@Maren" and leaving
 * a stray surname behind.
 *
 * The boundaries either side are Unicode letters rather than ASCII ones, so "@Alan" is not
 * found inside "@Alanè" any more than inside "@Alanis", and a name is still a name when it
 * follows a character this alphabet has never heard of.
 *
 * Two people who share a display name are both named. Guessing which of them was meant would
 * be worse than telling both: the writer typed one name and it belongs to two people.
 */
export function parseMentions(body: string, members: Mentionable[]): string[] {
  const byName = new Map<string, string[]>();
  for (const member of members) {
    const key = member.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), member.id]);
  }

  const found = new Set<string>();
  let remaining = body;
  const names = [...byName.keys()].sort((left, right) => right.length - left.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_'-])`, "giu");
    if (!pattern.test(remaining)) continue;
    for (const id of byName.get(name) ?? []) found.add(id);
    // Struck out so a shorter name inside this one cannot match the same words again.
    remaining = remaining.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_'-])`, "giu"),
      " ",
    );
  }
  return [...found];
}

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
    mentions: value.mentions ? String(value.mentions).split(",") : [],
  };
}

const SELECT_MESSAGES = `SELECT page_discussion.*,
         authors.name AS current_author_name,
         answerers.name AS answered_by_name,
         agent_tokens.name AS agent_name,
         (SELECT group_concat(user_id) FROM discussion_mentions
           WHERE discussion_mentions.message_id = page_discussion.id) AS mentions
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
export function listDiscussion(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
): DiscussionThread[] {
  const values = database.prepare(SELECT_MESSAGES).all(projectId, pageId) as Row[];
  const threads = new Map<string, DiscussionThread>();
  for (const value of values) {
    if (value.parent_id !== null) continue;
    threads.set(String(value.id), {
      ...message(value),
      replies: [],
      answeredAt: value.answered_at === null ? null : String(value.answered_at),
      answeredById: value.answered_by === null ? null : String(value.answered_by),
      answeredByName:
        value.answered_by_name === null || value.answered_by_name === undefined
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

/**
 * How much of a page's conversation this person has not read yet.
 *
 * Counted per person and never shared: this answers "is there something here for me", which is
 * the only question the switch on the column is asking. What you wrote yourself never counts -
 * you have read what you wrote - and a page you have never opened counts everything on it.
 *
 * What your agent wrote does count. A token is a delegation and every write it makes is
 * attributed to the person who issued it, but that person has not read it: an agent reporting
 * that it deployed something is news to them, and treating it as their own writing would have
 * made the one thing agents are best at the one thing nobody is told about.
 *
 * The seen mark is compared with `>=` rather than `>`. A message written in the same
 * millisecond as the mark may have arrived after the reading, and the safe direction for a
 * count of what somebody has not read is to count it again.
 *
 * One query for the whole board rather than one per tile, for the same reason the open-thread
 * counts are gathered that way.
 */
export function unseenCounts(database: DatabaseSync, projectId: string, userId: string): Map<string, number> {
  const values = database
    .prepare(
      `SELECT page_discussion.page_id AS page_id, COUNT(*) AS unseen
       FROM page_discussion
       LEFT JOIN discussion_seen
         ON discussion_seen.project_id = page_discussion.project_id
        AND discussion_seen.page_id = page_discussion.page_id
        AND discussion_seen.user_id = ?
       WHERE page_discussion.project_id = ?
         AND NOT (page_discussion.author_id = ? AND page_discussion.agent_token_id IS NULL)
         AND (discussion_seen.seen_at IS NULL OR page_discussion.created_at >= discussion_seen.seen_at)
       GROUP BY page_discussion.page_id`,
    )
    .all(userId, projectId, userId) as Row[];
  return new Map(values.map((value) => [String(value.page_id), Number(value.unseen)]));
}

/** The same count for one page, for a read that did not gather the whole board. */
export function unseenCount(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  userId: string,
): number {
  return unseenCounts(database, projectId, userId).get(pageId) ?? 0;
}

/**
 * Marks a page's conversation read up to now.
 *
 * Written when somebody opens the column, which is the only moment they can be said to have
 * looked. Anything posted after this instant is unseen again, including while they are still
 * looking at it - the next open settles that, and a count that flickers is better than one
 * that lies.
 */
export function markSeen(database: DatabaseSync, projectId: string, pageId: string, userId: string): void {
  database
    .prepare(
      `INSERT INTO discussion_seen (project_id, user_id, page_id, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, page_id) DO UPDATE SET seen_at = excluded.seen_at`,
    )
    .run(projectId, userId, pageId, new Date().toISOString());
}

/**
 * The same unread count, narrowed to the messages that named you.
 *
 * A subset of `unseenCounts` by construction: it walks the same rows and keeps the ones with
 * a mention row pointing at this person.
 */
export function unseenMentionCounts(
  database: DatabaseSync,
  projectId: string,
  userId: string,
): Map<string, number> {
  const values = database
    .prepare(
      `SELECT page_discussion.page_id AS page_id, COUNT(*) AS unseen
       FROM page_discussion
       JOIN discussion_mentions
         ON discussion_mentions.message_id = page_discussion.id
        AND discussion_mentions.user_id = ?
       LEFT JOIN discussion_seen
         ON discussion_seen.project_id = page_discussion.project_id
        AND discussion_seen.page_id = page_discussion.page_id
        AND discussion_seen.user_id = ?
       WHERE page_discussion.project_id = ?
         AND NOT (page_discussion.author_id = ? AND page_discussion.agent_token_id IS NULL)
         AND (discussion_seen.seen_at IS NULL OR page_discussion.created_at >= discussion_seen.seen_at)
       GROUP BY page_discussion.page_id`,
    )
    .all(userId, userId, projectId, userId) as Row[];
  return new Map(values.map((value) => [String(value.page_id), Number(value.unseen)]));
}

/** The same count for one page. */
export function unseenMentionCount(
  database: DatabaseSync,
  projectId: string,
  pageId: string,
  userId: string,
): number {
  return unseenMentionCounts(database, projectId, userId).get(pageId) ?? 0;
}

/** Records who a message named, once, at the moment it is written. */
function saveMentions(database: DatabaseSync, messageId: string, mentions: string[]): void {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO discussion_mentions (message_id, user_id) VALUES (?, ?)",
  );
  for (const userId of mentions) insert.run(messageId, userId);
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
  mentions: string[] = [],
): DiscussionThread {
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO page_discussion (id, project_id, page_id, parent_id, author_id, author_name, agent_token_id, body, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      pageId,
      author.id,
      author.name,
      author.agentTokenId ?? null,
      body,
      new Date().toISOString(),
    );
  saveMentions(database, id, mentions);
  return findThread(database, projectId, pageId, id) as DiscussionThread;
}

export type ReplyResult = DiscussionThread | "no_thread" | "answered";

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
  mentions: string[] = [],
): ReplyResult {
  const thread = findThread(database, projectId, pageId, threadId);
  if (!thread) return "no_thread";
  /*
   * A settled thread stays settled.
   *
   * The interface offers no reply on one, so this only ever refuses something holding a stale
   * copy of the page - an agent that read the conversation before somebody closed the question
   * it was about to answer. Its reply would land folded away behind the answered count, which
   * is a worse outcome than being told to say it somewhere it will be read.
   */
  if (thread.answeredAt !== null) return "answered";
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO page_discussion (id, project_id, page_id, parent_id, author_id, author_name, agent_token_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      pageId,
      threadId,
      author.id,
      author.name,
      author.agentTokenId ?? null,
      body,
      new Date().toISOString(),
    );
  saveMentions(database, id, mentions);
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
