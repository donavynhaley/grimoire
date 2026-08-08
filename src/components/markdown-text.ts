/**
 * Reduces Markdown to plain text for compact card and idea previews.
 *
 * This is deliberately an approximation rather than a parser: it clears the syntax
 * people actually type into notes so tiles read as prose. An unhandled edge case
 * degrades to showing the raw syntax, which is exactly what tiles showed before
 * notes were rendered at all. Single underscores are left alone so identifiers
 * like wizard_tower_door survive untouched.
 */
export function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(?:```|~~~).*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([^*]*\S)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
