import type { DatabaseSync } from "node:sqlite";
import type { ProjectCategory } from "../../shared/types";
import type { MarkdownPageStore } from "../markdown-pages";
import { slugify } from "../slug";
import { PageDependencyError } from "./errors";
import { projectById } from "./projects";
import { row, rows } from "./rows";

// A project's categories: the colored labels its pages may carry.

export function categoriesForProject(database: DatabaseSync, projectId: string): ProjectCategory[] {
  return rows(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? ORDER BY position, created_at",
    projectId,
  ).map((value) => ({
    slug: String(value.slug),
    name: String(value.name),
    color: String(value.color),
    position: Number(value.position),
  }));
}

export function categorySlugFromName(name: string): string {
  return slugify(name, 40);
}

export type CreateCategoryResult = { category: ProjectCategory } | "exists" | "invalid_name";

export function createCategory(
  database: DatabaseSync,
  projectId: string,
  input: { name: string; color: string },
): CreateCategoryResult {
  const slug = categorySlugFromName(input.name);
  if (!slug) return "invalid_name";
  if (row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    return "exists";
  }
  const position = categoriesForProject(database, projectId).length;
  database
    .prepare(
      "INSERT INTO categories (project_id, slug, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(projectId, slug, input.name, input.color, position, new Date().toISOString());
  return { category: { slug, name: input.name, color: input.color, position } };
}

export function updateCategory(
  database: DatabaseSync,
  projectId: string,
  slug: string,
  input: { name?: string; color?: string; position?: number },
): ProjectCategory | null {
  const current = row(
    database,
    "SELECT slug, name, color, position FROM categories WHERE project_id = ? AND slug = ?",
    projectId,
    slug,
  );
  if (!current) return null;
  const name = input.name ?? String(current.name);
  const color = input.color ?? String(current.color);
  const position = input.position ?? Number(current.position);
  database
    .prepare("UPDATE categories SET name = ?, color = ?, position = ? WHERE project_id = ? AND slug = ?")
    .run(name, color, position, projectId, slug);
  return { slug, name, color, position };
}

export function deleteCategory(
  database: DatabaseSync,
  pageStore: MarkdownPageStore,
  projectId: string,
  slug: string,
): boolean {
  const project = projectById(database, projectId);
  if (!project) return false;
  const exists = row(
    database,
    "SELECT 1 AS present FROM categories WHERE project_id = ? AND slug = ?",
    projectId,
    slug,
  );
  if (!exists) return false;
  // Pages release the value before the definition goes, because the two writes cannot
  // share a transaction: interrupted this way around, the category still exists and
  // deleting it again finishes the job - the other way, pages hold a value the strict
  // schema no longer accepts.
  const now = new Date().toISOString();
  pageStore.list(String(project.slug)).forEach((page) => {
    if (page.category !== slug) return;
    pageStore.save(String(project.slug), { ...page, category: null, updatedAt: now });
  });
  const removed = database
    .prepare("DELETE FROM categories WHERE project_id = ? AND slug = ?")
    .run(projectId, slug);
  return Number(removed.changes) === 1;
}

export function requireProjectCategory(database: DatabaseSync, projectId: string, slug: string): void {
  if (!row(database, "SELECT 1 AS ok FROM categories WHERE project_id = ? AND slug = ?", projectId, slug)) {
    throw new PageDependencyError("This category is not part of the project", 400);
  }
}
