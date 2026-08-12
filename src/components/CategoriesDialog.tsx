import { type FormEvent, useState } from "react";
import { CATEGORY_COLOR_PALETTE, type ProjectCategory } from "../../shared/types";
import { ApiError } from "../api/client";
import { useDialogEscape } from "./use-dialog-escape";

export type CategoryActions = {
  create: (input: { name: string; color: string }) => Promise<void>;
  update: (slug: string, input: { name?: string; color?: string }) => Promise<void>;
  remove: (slug: string) => Promise<void>;
};

type Props = {
  categories: ProjectCategory[];
  busy: boolean;
  actions: CategoryActions;
  onClose: () => void;
};

export function CategoriesDialog({ categories, busy, actions, onClose }: Props) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(CATEGORY_COLOR_PALETTE[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recoloring, setRecoloring] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");

  const run = async (change: () => Promise<void>, failure: string) => {
    setError("");
    try {
      await change();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : failure);
    }
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await actions.create({ name, color: newColor });
      setNewName("");
    }, "The category could not be created");
  };

  const saveName = (category: ProjectCategory) => {
    const draft = drafts[category.slug]?.trim();
    if (draft === undefined || draft === category.name) return;
    if (!draft) {
      setDrafts((current) => ({ ...current, [category.slug]: category.name }));
      return;
    }
    void run(() => actions.update(category.slug, { name: draft }), "The category could not be renamed");
  };

  useDialogEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="categories-dialog-title" aria-modal="true" className="card-dialog categories-dialog" role="dialog">
        <header className="dialog-header">
          <div><p className="eyebrow">project setup</p><h2 id="categories-dialog-title">Card categories</h2></div>
          <button aria-label="Close categories" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="category-manager">
          {categories.map((category) => (
            <div className="category-row" key={category.slug}>
              <button
                aria-expanded={recoloring === category.slug}
                aria-label={`Change color of ${category.name}`}
                className="category-color-trigger"
                onClick={() => setRecoloring(recoloring === category.slug ? null : category.slug)}
                type="button"
              >
                <span className="category-swatch" style={{ "--category-color": category.color } as React.CSSProperties} />
              </button>
              <label className="sr-only" htmlFor={`category-name-${category.slug}`}>Rename {category.name}</label>
              <input
                id={`category-name-${category.slug}`}
                name={`categoryName-${category.slug}`}
                onBlur={() => saveName(category)}
                onChange={(event) => setDrafts((current) => ({ ...current, [category.slug]: event.target.value }))}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveName(category); } }}
                value={drafts[category.slug] ?? category.name}
              />
              {removing === category.slug ? (
                <span className="archive-confirm">
                  <span>remove?</span>
                  <button
                    aria-label={`Confirm delete ${category.name}`}
                    className="danger-text"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await actions.remove(category.slug);
                      setRemoving(null);
                    }, "The category could not be deleted")}
                    type="button"
                  >yes</button>
                  <button aria-label={`Cancel deleting ${category.name}`} onClick={() => setRemoving(null)} type="button">no</button>
                </span>
              ) : (
                <button
                  aria-label={`Delete ${category.name}`}
                  className="icon-button"
                  onClick={() => setRemoving(category.slug)}
                  type="button"
                >×</button>
              )}
              {recoloring === category.slug && (
                <div aria-label={`Colors for ${category.name}`} className="category-palette">
                  {CATEGORY_COLOR_PALETTE.map((color) => (
                    <button
                      aria-label={`Use color ${color}`}
                      aria-pressed={category.color === color}
                      className={category.color === color ? "selected" : ""}
                      key={color}
                      onClick={() => void run(async () => {
                        await actions.update(category.slug, { color });
                        setRecoloring(null);
                      }, "The color could not be changed")}
                      style={{ "--category-color": color } as React.CSSProperties}
                      type="button"
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {categories.length === 0 && <p className="empty-dependencies">No categories yet. Add the first one below.</p>}
        </div>

        <form className="category-add" onSubmit={submitCreate}>
          <span className="field-label">Add a category</span>
          <div aria-label="New category color" className="category-palette">
            {CATEGORY_COLOR_PALETTE.map((color) => (
              <button
                aria-label={`Pick color ${color}`}
                aria-pressed={newColor === color}
                className={newColor === color ? "selected" : ""}
                key={color}
                onClick={() => setNewColor(color)}
                style={{ "--category-color": color } as React.CSSProperties}
                type="button"
              />
            ))}
          </div>
          <div className="category-add-row">
            <label className="sr-only" htmlFor="new-category-name">New category name</label>
            <input
              id="new-category-name"
              name="newCategoryName"
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Category name..."
              value={newName}
            />
            <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">add</button>
          </div>
        </form>

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
