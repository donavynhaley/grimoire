import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PageAttachment } from "../shared/attachments";

/** Single byte ranges let the browser seek without downloading the recording again. */
export function sendAttachment(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  attachment: PageAttachment,
  download: boolean,
): void {
  const size = statSync(path).size;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", attachment.mediaType);
  response.setHeader("Accept-Ranges", "bytes");
  const encoded = encodeURIComponent(attachment.filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  response.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="attachment"; filename*=UTF-8''${encoded}`,
  );
  let start = 0;
  let end = size - 1;
  const range = request.headers.range;
  if (range && request.method !== "HEAD") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      start > end
    ) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${size}`);
      response.end();
      return;
    }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else response.statusCode = 200;
  response.setHeader("Content-Length", end - start + 1);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
