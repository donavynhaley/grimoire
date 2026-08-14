#!/usr/bin/env node
// Removes the `chapter:` frontmatter key from every page file in a project directory.
//
// This exists for one situation: rolling a deployment back to a Grimoire build that predates
// chapters. That build's page schema is strict and rejects any frontmatter key it does not
// know, and the store reads every file before returning any of them, so a single chaptered
// page would fail the whole board rather than degrade one page.
//
// Pages are only written with the key when they actually belong to a chapter, so on most
// projects this touches very little. Chapter files under chapters/ are left alone: the older
// build never reads that directory, and keeping them means rolling forward again restores
// every chapter intact. Only the page membership is lost.
//
// Run this BEFORE ops/rename-pages-to-cards.mjs when rolling back past both changes; it reads
// whichever of pages/ or cards/ the project currently has.
//
//   node ops/strip-chapter-frontmatter.mjs <pages-directory> [--apply]
//
// Without --apply it reports what it would change and writes nothing.

import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const [, , root, ...flags] = process.argv;
const apply = flags.includes("--apply");

if (!root) {
  console.error("usage: node ops/strip-chapter-frontmatter.mjs <pages-directory> [--apply]");
  process.exit(2);
}

/**
 * Page files live in <project>/pages (or <project>/cards before the rename) and
 * <project>/archive. Chapters are deliberately skipped.
 */
function pageDirectories(directory) {
  const found = [];
  for (const project of readdirSync(directory, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of ["pages", "cards", "archive"]) {
      const path = join(directory, project.name, name);
      try {
        if (statSync(path).isDirectory()) found.push(path);
      } catch {
        // A project without an archive directory is normal.
      }
    }
  }
  return found;
}

/**
 * Drops the chapter line from the frontmatter block only.
 *
 * The body is never touched, so a note that happens to contain a line starting with
 * "chapter:" survives untouched.
 */
function stripChapter(contents) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, rest] = match;
  const lines = frontmatter.split(/\r?\n/);
  const kept = lines.filter((line) => !/^chapter:\s/.test(line));
  if (kept.length === lines.length) return null;
  return `---\n${kept.join("\n")}\n---${rest}`;
}

/** Written the same way the application writes: temporary file, then an atomic rename. */
function writeAtomic(path, contents) {
  const temporary = join(join(path, ".."), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

let scanned = 0;
let changed = 0;

for (const directory of pageDirectories(root)) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    scanned += 1;
    const stripped = stripChapter(readFileSync(path, "utf8"));
    if (stripped === null) continue;
    changed += 1;
    console.log(`${apply ? "stripped" : "would strip"} ${path}`);
    if (apply) writeAtomic(path, stripped);
  }
}

console.log(
  `\n${scanned} page file${scanned === 1 ? "" : "s"} scanned, ${changed} carrying a chapter.` +
    (apply ? " Done." : "\nRe-run with --apply to write the changes."),
);
