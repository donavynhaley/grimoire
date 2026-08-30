import { type FormEvent, useState } from "react";
import { CATEGORY_COLOR_PALETTE, type ProjectCategory } from "../../shared/types";
import type { SettingsRun } from "../hooks/use-settings-action";
import { categoryColorStyle } from "../lib/category-style";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";

export type CategoryActions = {
  create: (input: { name: string; color: string }) => Promise<void>;
  update: (slug: string, input: { name?: string; color?: string; position?: number }) => Promise<void>;
  remove: (slug: string) => Promise<void>;
};

type Props = {
  categories: ProjectCategory[];
  busy: boolean;
  actions: CategoryActions;
  /** Members read the list; only an owner reshapes it. */
  canManage: boolean;
  run: SettingsRun;
};

export function CategoriesSection({ categories, busy, actions, canManage, run }: Props) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(CATEGORY_COLOR_PALETTE[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recoloring, setRecoloring] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const ordered = [...categories].sort((a, b) => a.position - b.position);

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

  // Positions are index-shaped (creation assigns the next index), so a move is the two
  // neighbours trading indexes rather than a renumber of the whole list.
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const moved = ordered[index]!;
    const displaced = ordered[target]!;
    void run(async () => {
      await actions.update(moved.slug, { position: target });
      await actions.update(displaced.slug, { position: index });
    }, "The category could not be moved");
  };

  if (!canManage) {
    return (
      <div className="settings-section">
        <p className="settings-summary">
          The disciplines this project tags its pages with. Only an owner can change them.
        </p>
        <ul className="settings-readonly-list">
          {ordered.map((category) => (
            <li key={category.slug}>
              <span className="category-swatch" style={categoryColorStyle(category.color)} />
              {category.name}
            </li>
          ))}
          {ordered.length === 0 && <li className="settings-summary">No categories yet.</li>}
        </ul>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="category-manager">
        {ordered.map((category, index) => (
          <Growing className="category-row" key={category.slug}>
            <button
              aria-expanded={recoloring === category.slug}
              aria-label={`Change color of ${category.name}`}
              className="category-color-trigger"
              onClick={() => setRecoloring(recoloring === category.slug ? null : category.slug)}
              type="button"
            >
              <span className="category-swatch" style={categoryColorStyle(category.color)} />
            </button>
            <label className="sr-only" htmlFor={`category-name-${category.slug}`}>
              Rename {category.name}
            </label>
            <input
              id={`category-name-${category.slug}`}
              name={`categoryName-${category.slug}`}
              onBlur={() => saveName(category)}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [category.slug]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveName(category);
                }
              }}
              value={drafts[category.slug] ?? category.name}
            />
            <span className="reorder-buttons">
              <button
                aria-label={`Move ${category.name} up`}
                className="icon-button"
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={`Move ${category.name} down`}
                className="icon-button"
                disabled={busy || index === ordered.length - 1}
                onClick={() => move(index, 1)}
                type="button"
              >
                ↓
              </button>
            </span>
            <ConfirmInline
              cancelAriaLabel={`Cancel deleting ${category.name}`}
              className="archive-confirm"
              confirmAriaLabel={`Confirm delete ${category.name}`}
              confirmDisabled={busy}
              onCancel={() => setRemoving(null)}
              onConfirm={() =>
                void run(async () => {
                  await actions.remove(category.slug);
                  setRemoving(null);
                }, "The category could not be deleted")
              }
              onOpen={() => setRemoving(category.slug)}
              open={removing === category.slug}
              question="remove?"
              trigger="×"
              triggerAriaLabel={`Delete ${category.name}`}
              triggerClass="icon-button"
            />
            {recoloring === category.slug && (
              <div aria-label={`Colors for ${category.name}`} className="category-palette">
                {CATEGORY_COLOR_PALETTE.map((color) => (
                  <button
                    aria-label={`Use color ${color}`}
                    aria-pressed={category.color === color}
                    className={category.color === color ? "selected" : ""}
                    key={color}
                    onClick={() =>
                      void run(async () => {
                        await actions.update(category.slug, { color });
                        setRecoloring(null);
                      }, "The color could not be changed")
                    }
                    style={categoryColorStyle(color)}
                    type="button"
                  />
                ))}
              </div>
            )}
          </Growing>
        ))}
        {ordered.length === 0 && (
          <p className="empty-dependencies">No categories yet. Add the first one below.</p>
        )}
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
              style={categoryColorStyle(color)}
              type="button"
            />
          ))}
        </div>
        <div className="category-add-row">
          <label className="sr-only" htmlFor="new-category-name">
            New category name
          </label>
          <input
            id="new-category-name"
            name="newCategoryName"
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Category name..."
            value={newName}
          />
          <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">
            add
          </button>
        </div>
      </form>
    </div>
  );
}
