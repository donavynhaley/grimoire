import { useState } from "react";
import { type Member, PAGE_STATUS_LABELS, PAGE_STATUSES, type ProjectCategory } from "../../shared/types";
import { Growing } from "./Growing";

const labels = PAGE_STATUS_LABELS;

/** Which attribute the bar is currently offering, or none. */
type Group = "status" | "assignee" | "category" | null;

type Props = {
  count: number;
  busy: boolean;
  categories: ProjectCategory[];
  members: Member[];
  onApply: (input: Record<string, unknown>) => Promise<void>;
  onClear: () => void;
};

/**
 * What can be done to the cards being held.
 *
 * It takes the moving bar's place and its shape, because it is the same kind of statement:
 * the board is in a mode, here is what the mode is for, and here is the way out of it. The
 * attributes are the three the rail puts first for one page - column, who, category - since
 * a selection is made to answer one of those questions about several pages at once.
 *
 * One group opens at a time, inside `Growing`, so the bar does not stand three rows tall
 * while it waits to be used and does not jump to its full height when it is (UI-1).
 */
export function SelectionBar({ busy, categories, count, members, onApply, onClear }: Props) {
  const [group, setGroup] = useState<Group>(null);
  const show = (next: Group) => setGroup((current) => (current === next ? null : next));
  const apply = async (input: Record<string, unknown>) => {
    setGroup(null);
    await onApply(input);
  };

  const tab = (name: Exclude<Group, null>, label: string) => (
    <button
      aria-expanded={group === name}
      className="text-button"
      disabled={busy}
      onClick={() => show(name)}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <Growing aria-label="Selected pages" className="selection-bar" role="group">
      <div className="selection-bar-head">
        <span className="selection-count" role="status">
          <strong>{count}</strong> selected
        </span>
        <div className="selection-actions">
          {tab("status", "column")}
          {tab("assignee", "who")}
          {tab("category", "category")}
          <button className="text-button" onClick={onClear} type="button">
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character */}
            clear <kbd aria-hidden="true">esc</kbd>
          </button>
        </div>
      </div>

      {group === "status" && (
        <div className="choice-grid status-choices">
          {PAGE_STATUSES.map((status) => (
            <button
              aria-label={`Move ${count} pages to ${labels[status]}`}
              className="choice"
              disabled={busy}
              key={status}
              onClick={() => void apply({ status, position: 99_999 })}
              type="button"
            >
              <span className={`column-dot ${status}`} />
              {labels[status]}
            </button>
          ))}
        </div>
      )}

      {group === "assignee" && (
        <div className="choice-grid assignee-choices">
          <button
            aria-label={`Unassign ${count} pages`}
            className="choice"
            disabled={busy}
            onClick={() => void apply({ assigneeId: null })}
            type="button"
          >
            unassigned
          </button>
          {members.map((member) => (
            <button
              aria-label={`Assign ${count} pages to ${member.name}`}
              className="choice"
              disabled={busy}
              key={member.id}
              onClick={() => void apply({ assigneeId: member.id })}
              type="button"
            >
              {member.name}
            </button>
          ))}
        </div>
      )}

      {group === "category" && (
        <div className="choice-grid category-choices">
          <button
            aria-label={`Clear the category on ${count} pages`}
            className="choice"
            disabled={busy}
            onClick={() => void apply({ category: null })}
            type="button"
          >
            none
          </button>
          {categories.map((category) => (
            <button
              aria-label={`Categorize ${count} pages as ${category.name}`}
              className="choice"
              disabled={busy}
              key={category.slug}
              onClick={() => void apply({ category: category.slug })}
              type="button"
            >
              {category.name}
            </button>
          ))}
        </div>
      )}
    </Growing>
  );
}
