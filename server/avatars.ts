import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./markdown-files";
import { sniffImageType } from "./project-images";

export type AvatarImageType = "image/png" | "image/jpeg" | "image/webp";

export const AVATAR_SIZE_LIMIT = 2_000_000;

const EXTENSIONS: Record<AvatarImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The notes sniffer, narrowed: a GIF is for notes, not faces, so it reads as no avatar at all. */
export function sniffAvatarType(data: Buffer): AvatarImageType | null {
  const type = sniffImageType(data);
  return type === null || type === "image/gif" ? null : type;
}

export type StoredAvatar = {
  path: string;
  contentType: AvatarImageType;
  version: number;
};

export class AvatarStore {
  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  get(userId: string): StoredAvatar | null {
    for (const [contentType, extension] of Object.entries(EXTENSIONS) as Array<[AvatarImageType, string]>) {
      const path = this.avatarPath(userId, extension);
      if (existsSync(path)) return { path, contentType, version: Math.trunc(statSync(path).mtimeMs) };
    }
    return null;
  }

  urlFor(userId: string): string | null {
    const avatar = this.get(userId);
    return avatar ? `/api/avatars/${userId}?v=${avatar.version}` : null;
  }

  save(userId: string, data: Buffer, contentType: AvatarImageType): void {
    // A new picture can arrive under a new extension, so every older variant goes
    // first - otherwise both would answer and get() would pick one arbitrarily.
    this.remove(userId);
    writeAtomic(this.avatarPath(userId, EXTENSIONS[contentType]), data);
  }

  remove(userId: string): boolean {
    let removed = false;
    for (const extension of Object.values(EXTENSIONS)) {
      const path = this.avatarPath(userId, extension);
      if (existsSync(path)) {
        unlinkSync(path);
        removed = true;
      }
    }
    return removed;
  }

  private avatarPath(userId: string, extension: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error(`Invalid avatar user id: ${userId}`);
    }
    return join(this.rootDirectory, `${userId}.${extension}`);
  }
}
