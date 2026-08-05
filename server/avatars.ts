import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AvatarImageType = "image/png" | "image/jpeg" | "image/webp";

export const AVATAR_SIZE_LIMIT = 2_000_000;

const EXTENSIONS: Record<AvatarImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffAvatarType(data: Buffer): AvatarImageType | null {
  if (data.length > 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length > 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
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
    const path = this.avatarPath(userId, EXTENSIONS[contentType]);
    const temporaryPath = join(this.rootDirectory, `.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.remove(userId);
      renameSync(temporaryPath, path);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
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
