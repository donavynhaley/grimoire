#!/usr/bin/env node
// Renames every project's `pages/` directory back to `cards/`.
//
// This reverses the rename that a current Grimoire performs on startup. A build that predates
// it looks for `<project>/cards/` and finds nothing, so rolling a deployment back without
// running this shows an empty board - the work is still on disk, but nothing points at it,
// which is indistinguishable from losing it until someone looks.
//
// Only the active directory moves. `archive/`, `ideas/`, `chapters/`, and `images/` were never
// named after the entity and are left alone.
//
//   node ops/rename-pages-to-cards.mjs <pages-directory> [--apply]
//
// Without --apply it reports what it would change and moves nothing. Run
// ops/strip-chapter-frontmatter.mjs FIRST when rolling back past chapters as well, because
// that one reads the files and this one moves them.

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const [, , root, ...flags] = process.argv;
const apply = flags.includes("--apply");

if (!root) {
  console.error("usage: node ops/rename-pages-to-cards.mjs <pages-directory> [--apply]");
  process.exit(2);
}

let moved = 0;
let skipped = 0;

for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const pages = join(root, project.name, "pages");
  const cards = join(root, project.name, "cards");
  if (!existsSync(pages)) continue;
  // Refuse rather than merge: two directories of pages is a situation a person should look at.
  if (existsSync(cards)) {
    console.error(`skipped ${project.name}: both pages/ and cards/ exist`);
    skipped += 1;
    continue;
  }
  moved += 1;
  console.log(`${apply ? "renamed" : "would rename"} ${pages} -> ${cards}`);
  if (apply) renameSync(pages, cards);
}

console.log(
  `\n${moved} project director${moved === 1 ? "y" : "ies"} to rename` +
    (skipped > 0 ? `, ${skipped} skipped` : "") +
    (apply ? ". Done." : ".\nRe-run with --apply to move them."),
);
if (skipped > 0) process.exit(1);
