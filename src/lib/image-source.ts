import { imageUrl } from "../api/client";

/**
 * Resolves the image references notes actually contain the way Obsidian would.
 *
 * Obsidian embeds arrive as bare file names, and hand-written relative paths such
 * as `images/goal.png` resolve by their final segment, so both find the project
 * images directory regardless of where the Markdown file itself lives. Absolute
 * URLs pass through untouched.
 *
 * It lives apart from the views that draw images because both of them need it now:
 * the rendered previews on tiles and the live-preview editor's own image widgets.
 */
export function resolveImageSource(src: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(src) || src.startsWith("/")) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // A malformed escape sequence is still a usable file name.
  }
  return imageUrl(decoded.split("/").pop() ?? decoded);
}

/**
 * Obsidian's `![[name|300x200]]` display sizes, as far as they are numbers.
 *
 * Anything else after the pipe is alt text, which is the same reading
 * `remarkObsidianEmbeds` gives it, so both renderers agree about what an embed means.
 */
export function embedDimensions(modifier: string | undefined): {
  width?: number;
  height?: number;
  alt: string;
} {
  const dimensions = modifier?.match(/^(\d+)(?:x(\d+))?$/);
  if (!dimensions) return { alt: modifier ?? "" };
  return { width: Number(dimensions[1]), height: dimensions[2] ? Number(dimensions[2]) : undefined, alt: "" };
}
