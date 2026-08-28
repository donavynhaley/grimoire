import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDirectory, writeAtomic } from "./markdown-files";

export type ProjectImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export const IMAGE_SIZE_LIMIT = 10_000_000;

const EXTENSIONS: Record<ProjectImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const CONTENT_TYPES: Record<string, ProjectImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageType(data: Buffer): ProjectImageType | null {
  if (data.length > 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length > 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length > 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  return null;
}

/**
 * Accepts the names Grimoire generates plus the names Obsidian and people produce
 * by hand, such as `Pasted image 20260807183045.png`. Rejects anything that could
 * step outside the images directory or hide as a dotfile.
 */
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9 ._-]*\.([A-Za-z0-9]+)$/;

export type StoredProjectImage = {
  path: string;
  contentType: ProjectImageType;
};

export class ProjectImageStore {
  constructor(readonly rootDirectory: string) {}

  get(projectSlug: string, imageName: string): StoredProjectImage | null {
    const match = imageName.match(IMAGE_NAME_PATTERN);
    const contentType = match ? CONTENT_TYPES[match[1]!.toLowerCase()] : undefined;
    if (!contentType) return null;
    const path = join(this.imagesDirectory(projectSlug), imageName);
    return existsSync(path) ? { path, contentType } : null;
  }

  save(projectSlug: string, data: Buffer, contentType: ProjectImageType): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const name = `pasted-image-${stamp}-${randomBytes(2).toString("hex")}.${EXTENSIONS[contentType]}`;
    writeAtomic(join(this.imagesDirectory(projectSlug), name), data);
    return name;
  }

  private imagesDirectory(projectSlug: string): string {
    return join(projectDirectory(this.rootDirectory, projectSlug), "images");
  }
}
