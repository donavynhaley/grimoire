import type { Chapter, ChapterRecap, Member } from "../shared/types";
import type { StoredChapter } from "./markdown-chapters";
import type { StoredPage } from "./markdown-pages";

/**
 * What a chapter looked like when it closed, gathered as facts rather than prose.
 *
 * A recap is the answer to "what happened in that stretch of work". Everything here is
 * counted from what the board already holds - nothing is forecast, nothing is inferred, and
 * nothing is written on anyone's behalf. The narrative version of this belongs to whoever
 * reads it, which is why the payload is served as well as posted: an agent that wants to
 * write the story gets the same numbers the plain post is built from.
 *
 * The comparison against previous chapters is the one place a number is derived. It is a
 * plain mean of what earlier chapters recorded delivering, and it is offered only once there
 * is more than one chapter to compare against, because "average of one" is not an average.
 */

export function buildRecap(
  chapter: StoredChapter,
  previousChapters: StoredChapter[],
  pages: StoredPage[],
  members: Member[],
  publicChapter: Chapter,
): ChapterRecap {
  const mine = pages.filter((page) => page.chapter === chapter.slug);
  const delivered = chapter.deliveredPages ?? mine.filter((page) => page.status === "done").length;
  const deliveredEstimate =
    chapter.deliveredEstimate ??
    mine.filter((page) => page.status === "done").reduce((sum, page) => sum + (page.estimate ?? 0), 0);

  /*
   * Who delivered what, counted from the pages themselves rather than the activity log.
   * The log records who *moved* a page, which is often whoever was tidying the board; the
   * assignee is who the team agreed was doing it.
   */
  const byPerson = members
    .map((member) => {
      const theirs = mine.filter((page) => page.assignee === member.email.toLowerCase());
      const done = theirs.filter((page) => page.status === "done");
      return {
        memberId: member.id,
        name: member.name,
        shipped: done.length,
        shippedEstimate: done.reduce((sum, page) => sum + (page.estimate ?? 0), 0),
        inFlight: theirs.filter((page) => page.status !== "done").length,
        titles: done.slice(0, 12).map((page) => page.title),
      };
    })
    .filter((person) => person.shipped > 0 || person.inFlight > 0)
    .sort((left, right) => right.shipped - left.shipped);

  const unassigned = mine.filter((page) => page.assignee === null && page.status === "done").length;

  // The whole project, not just this chapter, so a recap can say where the work stands.
  const everything = pages;
  const projectDone = pages.filter((page) => page.status === "done").length;
  const projectBacklog = pages.filter((page) => page.status === "backlog").length;

  const previousDelivered = previousChapters
    .map((candidate) => candidate.deliveredPages)
    .filter((value): value is number => value !== null);
  const previousEstimate = previousChapters
    .map((candidate) => candidate.deliveredEstimate)
    .filter((value): value is number => value !== null);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    chapter: publicChapter,
    delivered,
    deliveredEstimate,
    carriedPages: chapter.carriedPages ?? 0,
    carriedEstimate: chapter.carriedEstimate ?? 0,
    carriedTo: chapter.carriedTo,
    // Only offered once there is something to compare against; "average of one" is not one.
    averageDelivered: previousDelivered.length > 0 ? mean(previousDelivered) : null,
    averageDeliveredEstimate: previousEstimate.length > 0 ? mean(previousEstimate) : null,
    byPerson,
    unassignedDelivered: unassigned,
    stillOpen: {
      ready: mine.filter((page) => page.status === "ready").length,
      inProgress: mine.filter((page) => page.status === "in_progress").length,
      review: mine.filter((page) => page.status === "review").length,
    },
    project: {
      done: projectDone,
      backlog: projectBacklog,
      total: everything.length,
    },
  };
}

/** A bar a person can read at a glance, in the shape the team already recognises. */
function bar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"🟩".repeat(filled)}${"⬜".repeat(width - filled)}`;
}

function change(current: number, average: number | null, unit: string): string {
  if (average === null) return "";
  const delta = current - average;
  const rounded = Math.round(average * 10) / 10;
  if (Math.abs(delta) < 0.05) return ` (avg ${rounded} ${unit})`;
  const arrow = delta > 0 ? "↑" : "↓";
  const percent = average === 0 ? null : Math.round((delta / average) * 100);
  const percentText = percent === null ? "" : ` / ${delta > 0 ? "+" : ""}${percent}%`;
  return ` (avg ${rounded} ${unit}, ${arrow} ${delta > 0 ? "+" : ""}${Math.round(delta * 10) / 10}${percentText})`;
}

/**
 * The recap as Discord messages.
 *
 * Split rather than truncated: a webhook message caps at 2000 characters and a real chapter
 * outgrows that as soon as a team of two has a good fortnight. The first message carries the
 * headline and the numbers, and each person gets their own after it, so nothing is ever cut
 * off mid-sentence to fit.
 */
export function recapMessages(recap: ChapterRecap, estimatesOn: boolean): string[] {
  const { chapter } = recap;
  const scope = recap.project.total;
  const completion = scope === 0 ? 0 : recap.project.done / scope;
  const lines: string[] = [];

  lines.push(`## ${chapter.name} — closed`);
  if (chapter.description) lines.push(`_${chapter.description.split("\n")[0]}_`);
  lines.push("");
  lines.push(`**Overall completion:** ${Math.round(completion * 100)}% ${bar(completion)}`);
  lines.push(
    `📈 **Delivered:** ${recap.delivered} page${recap.delivered === 1 ? "" : "s"}` +
      `${change(recap.delivered, recap.averageDelivered, "pages")}`,
  );
  if (estimatesOn) {
    lines.push(
      `🎯 **Velocity:** ${recap.deliveredEstimate} pts` +
        `${change(recap.deliveredEstimate, recap.averageDeliveredEstimate, "pts")}`,
    );
  }
  if (recap.carriedPages > 0) {
    const where = recap.carriedTo ? ` into ${recap.carriedTo}` : " onward";
    lines.push(
      `↪️ **Carried:** ${recap.carriedPages} page${recap.carriedPages === 1 ? "" : "s"}` +
        `${estimatesOn && recap.carriedEstimate > 0 ? ` (${recap.carriedEstimate} pts)` : ""}${where}`,
    );
  }
  lines.push("");
  lines.push(
    `🏁 Done overall: ${recap.project.done} · 📋 Backlog: ${recap.project.backlog} · ` +
      `🎯 Total scope: ${recap.project.total}`,
  );

  const messages = [lines.join("\n")];

  for (const person of recap.byPerson) {
    const head =
      `💪 **${person.name}** — ${person.shipped} shipped` +
      `${estimatesOn && person.shippedEstimate > 0 ? ` (${person.shippedEstimate} pts)` : ""}` +
      ` · ${person.inFlight} in flight`;
    const titles = person.titles.map((title) => `• ${title}`).join("\n");
    messages.push(titles ? `${head}\n${titles}` : head);
  }

  if (recap.unassignedDelivered > 0) {
    messages.push(`👥 **Unassigned** — ${recap.unassignedDelivered} shipped`);
  }

  // Nothing is ever cut off mid-sentence; a message that would exceed the cap is split.
  return messages.flatMap(splitForDiscord);
}

const DISCORD_LIMIT = 1900;

function splitForDiscord(message: string): string[] {
  if (message.length <= DISCORD_LIMIT) return [message];
  const parts: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    if (current.length + line.length + 1 > DISCORD_LIMIT) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** The one seam on Discord, so tests can be Discord. */
export type DiscordPoster = (webhookUrl: string, content: string) => Promise<{ ok: boolean; status: number }>;

export const discordPoster: DiscordPoster = async (webhookUrl, content) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return { ok: response.ok, status: response.status };
};

/** Sends a recap, one message at a time so Discord keeps them in order. */
export async function postRecap(
  poster: DiscordPoster,
  webhookUrl: string,
  messages: string[],
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    try {
      const result = await poster(webhookUrl, message);
      if (result.ok) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
