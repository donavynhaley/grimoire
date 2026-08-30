/**
 * Spreads the demo's conversation back over a few days.
 *
 * Everything the seeder writes is stamped with the moment it ran, so a board that should read
 * "3d / 2d / 20m" reads "just now" nine times over and the relative timestamps - which are a
 * real part of what this section looks like - cannot be judged at all.
 *
 * Run with the server stopped. This opens the SQLite file directly, which is exactly the kind
 * of write the application must never do behind its own back; it is acceptable here only
 * because the thing being edited is a throwaway demo and nobody is holding it open.
 *
 * Usage: node scripts/backdate-demo.mjs [path/to/grimoire.sqlite]
 */
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] ?? "./demo-data/grimoire.sqlite";
const database = new DatabaseSync(path);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back each message sits, oldest first, so a thread still reads in order. */
const AGES = [
  4 * DAY,
  3 * DAY,
  2 * DAY + 6 * HOUR,
  2 * DAY,
  DAY + 3 * HOUR,
  DAY,
  5 * HOUR,
  2 * HOUR,
  40 * MINUTE,
  20 * MINUTE,
  6 * MINUTE,
];

const now = Date.now();
const stamp = (age) => new Date(now - age).toISOString();

// Roots first, then replies, so a reply is never older than the question it answers.
const roots = database
  .prepare("SELECT id FROM page_discussion WHERE parent_id IS NULL ORDER BY created_at ASC, rowid ASC")
  .all();

let index = 0;
const setCreated = database.prepare("UPDATE page_discussion SET created_at = ? WHERE id = ?");
const setAnswered = database.prepare(
  "UPDATE page_discussion SET answered_at = ? WHERE id = ? AND answered_at IS NOT NULL",
);
const repliesOf = database.prepare(
  "SELECT id FROM page_discussion WHERE parent_id = ? ORDER BY created_at ASC, rowid ASC",
);

for (const root of roots) {
  const age = AGES[Math.min(index, AGES.length - 1)];
  setCreated.run(stamp(age), root.id);
  index += 1;

  let replyAge = age;
  for (const reply of repliesOf.all(root.id)) {
    // Each reply lands somewhere after its question and before now.
    replyAge = Math.max(replyAge - Math.floor(age / 3) - HOUR, 12 * MINUTE);
    setCreated.run(stamp(replyAge), reply.id);
  }
  setAnswered.run(stamp(Math.max(replyAge - HOUR, 8 * MINUTE)), root.id);
}

// The pages themselves, so "created by" and the history do not all claim this minute either.
const pages = database.prepare("SELECT DISTINCT page_id FROM page_discussion").all();
console.log(`Backdated ${roots.length} threads across ${pages.length} pages.`);

database.close();
