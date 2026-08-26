import type { Member } from "../../shared/types";

/**
 * A message body with the people it named picked out of it.
 *
 * The server decided who was meant when the message was written and sends their ids along, so
 * nothing here guesses: it only finds where in the text those people were written, and marks
 * that span. A name that resolved to nobody was never a mention and stays as it was typed.
 *
 * Longest names first, so "@Maren Voss" is one name rather than "@Maren" with a surname
 * trailing after it, and the same word-boundary rule the server used keeps "@Alanis" out of
 * "@Alan".
 */
export function withMentions(
  body: string,
  mentions: string[] | undefined,
  members: Member[],
  currentUserId: string,
): React.ReactNode {
  // A payload from before this existed carries no list at all; it named nobody.
  if (!mentions || mentions.length === 0) return body;
  const named = members
    .filter((member) => mentions.includes(member.id))
    .sort((left, right) => right.name.length - left.name.length);
  if (named.length === 0) return body;

  /*
   * The same boundaries the server used, on both sides.
   *
   * Without the leading one this marked a name inside an address - `maren@example` reading as
   * a mention of Maren - which the server never counted, so the highlight would have claimed
   * something the unread count disagreed with.
   */
  const escaped = named.map((member) => member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_@])@(?:${escaped.join("|")})(?![\\p{L}\\p{N}_'-])`,
    "giu",
  );

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(body.slice(cursor, at));
    const written = match[0];
    const member = named.find((candidate) => `@${candidate.name}`.toLowerCase() === written.toLowerCase());
    nodes.push(
      <span
        className={member?.id === currentUserId ? "mention you" : "mention"}
        key={`${at}-${written}`}
      >
        {written}
      </span>,
    );
    cursor = at + written.length;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes;
}
