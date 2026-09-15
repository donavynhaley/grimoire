import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { promisify } from "node:util";
import type { AttachmentMediaType } from "../shared/attachments";
import { HttpError } from "./http";
import { sniffImageType } from "./project-images";

const run = promisify(execFile);
const FORMATS: Record<AttachmentMediaType, string> = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/webp": "webp_pipe",
  "image/gif": "gif",
  "video/mp4": "mov",
};
let validating = 0;

/** Decode with maintained media parsers, bounded CPU concurrency, dimensions, and time. */
export async function validateAttachmentMedia(path: string, type: AttachmentMediaType): Promise<void> {
  const header = Buffer.alloc(32);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header);
  } finally {
    closeSync(fd);
  }
  const detected = sniffImageType(header);
  if (type === "video/mp4" ? header.toString("ascii", 4, 8) !== "ftyp" : detected !== type) {
    throw new HttpError(415, "File content does not match its media type. Use PNG, JPEG, WebP, GIF, or MP4.");
  }
  if (validating >= 2) throw new HttpError(503, "Media validation is busy. Retry completion shortly.");
  validating++;
  try {
    // Force the demuxer rather than allowing playlists or arbitrary format auto-detection.
    // MOV external data references remain disabled; network protocols are never available.
    const input = [
      "-protocol_whitelist",
      "file",
      "-f",
      FORMATS[type],
      ...(type === "video/mp4" ? ["-enable_drefs", "0"] : []),
      "-i",
      path,
    ];
    const { stdout } = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-max_alloc",
        "268435456",
        "-threads",
        "1",
        ...input,
        "-show_streams",
        "-show_format",
        "-of",
        "json",
      ],
      { timeout: 15_000, maxBuffer: 256_000 },
    );
    const probe = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const videos = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    if (
      videos.length !== 1 ||
      !videos[0]?.width ||
      !videos[0].height ||
      videos[0].width * videos[0].height > 16_777_216
    ) {
      throw new HttpError(415, "Media must contain one image or video track, at most 16 megapixels.");
    }
    if (
      type === "video/mp4" &&
      (videos[0].codec_name !== "h264" ||
        (probe.streams ?? []).some((stream) => stream.codec_type === "audio" && stream.codec_name !== "aac"))
    ) {
      throw new HttpError(
        415,
        "MP4 recordings must use H.264 video and optional AAC audio for browser playback.",
      );
    }
    const duration = Number(probe.format?.duration ?? 0);
    if (duration > 600 || (type === "video/mp4" && (!Number.isFinite(duration) || duration <= 0))) {
      throw new HttpError(415, "Recordings and animated images must be no longer than 10 minutes.");
    }
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-threads",
        "1",
        "-max_alloc",
        "268435456",
        ...input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-threads",
        "1",
        "-f",
        "null",
        "-",
      ],
      { timeout: 60_000, maxBuffer: 256_000 },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(
        503,
        "Media validation is unavailable. The operator must install FFmpeg and ffprobe; then retry completion.",
      );
    }
    throw new HttpError(
      415,
      "Media could not be decoded within the validation limits. Re-export the image or an H.264/AAC MP4 and start a new upload.",
    );
  } finally {
    validating--;
  }
}
