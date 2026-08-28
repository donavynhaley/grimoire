/**
 * One slugifier for everything that turns a human name into a stable identifier -
 * projects, categories, chapters, field keys. Four copies of this chain existed,
 * differing only in their length cap, which is now the argument it always was.
 */
export function slugify(name: string, limit: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit)
    .replace(/-+$/g, "");
}
