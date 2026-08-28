import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * A flat map, written inline as JSON. Nesting is deliberately not supported: the parser is a
 * line-oriented reader rather than a YAML implementation, and a value that could contain
 * another map would need one.
 */
export type FrontmatterRecord = Record<string, string | number | boolean>;

export type FrontmatterValue = string | number | null | string[] | FrontmatterRecord;

export function parseMarkdown(markdown: string): { metadata: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Expected YAML frontmatter enclosed by --- lines");
  const metadata: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (key in metadata) throw new Error(`Duplicate frontmatter field: ${key}`);
    metadata[key] = parseScalar(line.slice(separator + 1).trim());
  }
  let body = match[2]!.replace(/^\r?\n/, "");
  body = body.replace(/\r?\n$/, "");
  return { metadata, body };
}

export function serializeMarkdown(metadata: Array<[string, FrontmatterValue]>, body: string): string {
  const frontmatter = metadata.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join("\n");
  const trailingNewline = body && !body.endsWith("\n") ? "\n" : "";
  return `---\n${frontmatter}\n---\n\n${body}${trailingNewline}`;
}

export function writeAtomic(path: string, content: string | Buffer): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    if (typeof content === "string") writeFileSync(descriptor, content, "utf8");
    else writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

/** Every store keeps a project's records under the same guarded directory shape. */
export function projectDirectory(rootDirectory: string, projectSlug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectSlug)) {
    throw new Error(`Invalid project slug: ${projectSlug}`);
  }
  return join(rootDirectory, projectSlug);
}

/** The record files in a directory: Markdown only, hidden files and strays left alone. */
export function markdownFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => join(directory, entry.name));
}

/**
 * Moves a record by writing the complete destination before removing the source, so an
 * interruption can only leave the record present twice - the source still authoritative,
 * the stray copy overwritten by the next attempt - never half-written.
 */
export function moveRecord(fromPath: string, toPath: string, content: string): void {
  writeAtomic(toPath, content);
  unlinkSync(fromPath);
}

/** The deterministic tie-break every record list sorts with: rank, position, creation, id. */
export function compareRecords<T extends { position: number; createdAt: string; id: string }>(
  rank: (record: T) => number,
): (left: T, right: T) => number {
  return (left, right) =>
    rank(left) - rank(right) ||
    left.position - right.position ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

export function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseScalar(value: string): FrontmatterValue {
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Frontmatter arrays must contain only strings");
    }
    return parsed;
  }
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Frontmatter records must be JSON objects");
    }
    for (const entry of Object.values(parsed)) {
      const type = typeof entry;
      if (type !== "string" && type !== "number" && type !== "boolean") {
        throw new Error("Frontmatter records may only hold strings, numbers, and booleans");
      }
    }
    return parsed as FrontmatterRecord;
  }
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("Quoted frontmatter values must be strings");
    return parsed;
  }
  if (!value) return "";
  return value;
}

function serializeScalar(value: FrontmatterValue): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  const unsafe =
    value.trim() !== value ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/.test(value) ||
    /^(?:null|true|false|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return unsafe ? JSON.stringify(value) : value;
}
