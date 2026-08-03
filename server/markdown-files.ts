import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type FrontmatterScalar = string | number | null;

export function parseMarkdown(markdown: string): { metadata: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Expected YAML frontmatter enclosed by --- lines");
  const metadata: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (key in metadata) throw new Error(`Duplicate frontmatter field: ${key}`);
    metadata[key] = parseScalar(line.slice(separator + 1).trim());
  }
  let body = match[2].replace(/^\r?\n/, "");
  body = body.replace(/\r?\n$/, "");
  return { metadata, body };
}

export function serializeMarkdown(metadata: Array<[string, FrontmatterScalar]>, body: string): string {
  const frontmatter = metadata.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join("\n");
  const trailingNewline = body && !body.endsWith("\n") ? "\n" : "";
  return `---\n${frontmatter}\n---\n\n${body}${trailingNewline}`;
}

export function writeAtomic(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
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

export function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseScalar(value: string): FrontmatterScalar {
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("Quoted frontmatter values must be strings");
    return parsed;
  }
  if (!value) return "";
  return value;
}

function serializeScalar(value: FrontmatterScalar): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  const unsafe =
    value.trim() !== value ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/.test(value) ||
    /^(?:null|true|false|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return unsafe ? JSON.stringify(value) : value;
}
