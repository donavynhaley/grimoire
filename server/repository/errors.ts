// The errors a repository write refuses with, and the optimistic-concurrency guard
// that raises one. They live below every domain module because pages, fields,
// categories and chapters all throw them while pages imports from all of the others.

export class PageDependencyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * A write refused because the stored value is not the one the editor was working from.
 *
 * The check is per field rather than per record so that editing a title never collides
 * with a teammate rewriting the notes. `current` is returned to the caller so the editor
 * can show what it collided with instead of asking for the record again.
 */
export class EditConflictError extends Error {
  constructor(
    message: string,
    readonly field: "title" | "description",
    readonly current: unknown,
  ) {
    super(message);
  }
}

/**
 * Rejects a write whose expected values no longer match what is stored.
 *
 * Callers send an expected value only for the fields they are actually changing, so an
 * untouched field can never manufacture a conflict.
 */
export function requireUnchangedContent(
  stored: { title: string; description: string },
  input: { expectedTitle?: string; expectedDescription?: string },
  current: unknown,
  noun: "page" | "idea" | "chapter",
): void {
  // Expectations arrive trimmed by the request schema, while a body hand-edited on disk may
  // carry margins the schema never saw. Comparing trimmed to trimmed keeps the check about
  // what the words are rather than their whitespace - otherwise a page with a padded body
  // would refuse every rewrite forever, because no trimmed expectation could ever match it.
  if (input.expectedTitle !== undefined && stored.title.trim() !== input.expectedTitle.trim()) {
    throw new EditConflictError(`This ${noun}'s title changed while you were editing it`, "title", current);
  }
  if (
    input.expectedDescription !== undefined &&
    stored.description.trim() !== input.expectedDescription.trim()
  ) {
    throw new EditConflictError("These notes changed while you were writing", "description", current);
  }
}
