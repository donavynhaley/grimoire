import { useEffect, useMemo, useState } from "react";
import { type Card, type CardCategory, type Member, type ProjectCategory } from "../../shared/types";
import { categoryDisplay, categoryStyle } from "./category-style";

type Props = {
  busy: boolean;
  cards: Card[];
  categories: ProjectCategory[];
  members: Member[];
  onClose: () => void;
  onOpenCard: (id: string) => void;
  onReopen: (id: string) => Promise<void>;
};

export function DoneHistoryDialog({ busy, cards, categories, members, onClose, onOpenCard, onReopen }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CardCategory | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const usedCategories = useMemo(
    () => [...new Set(cards.map((card) => card.category).filter((value): value is CardCategory => Boolean(value)))],
    [cards],
  );
  const visibleCards = useMemo(
    () => cards
      .filter((card) => {
        if (category && card.category !== category) return false;
        if (person && (card.assigneeId ?? "unassigned") !== person) return false;
        return !normalizedQuery || cardText(card).includes(normalizedQuery);
      })
      .sort(compareCompletion),
    [cards, category, normalizedQuery, person],
  );
  const groups = useMemo(() => groupByMonth(visibleCards), [visibleCards]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop library-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="history-dialog-title" aria-modal="true" className="library-dialog" role="dialog">
        <header className="dialog-header library-header">
          <div>
            <p className="eyebrow">project record</p>
            <h2 id="history-dialog-title">Completed work</h2>
            <p>{cards.length} finished card{cards.length === 1 ? "" : "s"}</p>
          </div>
          <button aria-label="Close completed work" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="library-tools">
          <label className="library-search">
            <span className="sr-only">Search completed work</span>
            <input
              aria-label="Search completed work"
              autoFocus
              id="completed-work-search"
              name="completedWorkSearch"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search completed work..."
              type="search"
              value={query}
            />
          </label>
          <div aria-label="Completed work filters" className="library-filters">
            <button aria-pressed={person === "unassigned"} className={person === "unassigned" ? "active" : ""} onClick={() => setPerson(person === "unassigned" ? null : "unassigned")} type="button">unassigned</button>
            {members.map((member) => (
              <button
                aria-pressed={person === member.id}
                className={person === member.id ? "active" : ""}
                key={member.id}
                onClick={() => setPerson(person === member.id ? null : member.id)}
                type="button"
              >{member.name}</button>
            ))}
          </div>
          {usedCategories.length > 0 && (
            <div aria-label="Completed work categories" className="library-filters category-filters">
              {usedCategories.map((value) => (
                <button
                  aria-pressed={category === value}
                  className={category === value ? "active" : ""}
                  key={value}
                  onClick={() => setCategory(category === value ? null : value)}
                  type="button"
                ><span className="category-swatch" style={categoryStyle(categories, value)} />{categoryDisplay(categories, value)}</button>
              ))}
            </div>
          )}
        </div>

        <div className="history-results" aria-live="polite">
          {groups.map(([label, groupCards]) => (
            <section className="history-group" key={label}>
              <header><h3>{label}</h3><span>{groupCards.length}</span></header>
              <div>
                {groupCards.map((card) => (
                  <article className={`history-card ${card.category ? "" : "category-none"}`} key={card.id} style={categoryStyle(categories, card.category)}>
                    <button className="history-card-main" onClick={() => onOpenCard(card.id)} type="button">
                      <span className={`category-swatch ${card.category ? "" : "category-none"}`} style={categoryStyle(categories, card.category)} />
                      <span><strong>{card.title}</strong><small>{card.assigneeName ?? "unassigned"}</small></span>
                      <time dateTime={card.completedAt ?? card.updatedAt}>{formatCompletion(card)}</time>
                    </button>
                    <button aria-label={`Move ${card.title} to Up Next`} className="history-reopen" disabled={busy} onClick={() => void onReopen(card.id)} type="button">reopen</button>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {visibleCards.length === 0 && (
            <div className="library-empty">
              <strong>{cards.length === 0 ? "Nothing finished yet." : "No completed cards match."}</strong>
              <span>{cards.length === 0 ? "Finished work will collect here automatically." : "Try a broader search or remove a filter."}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function cardText(card: Card): string {
  return `${card.title}\n${card.description}\n${card.category ?? "uncategorized"}\n${card.assigneeName ?? "unassigned"}`.toLowerCase();
}

function compareCompletion(left: Card, right: Card): number {
  const timestamp = (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
  return timestamp || right.position - left.position;
}

function groupByMonth(cards: Card[]): Array<[string, Card[]]> {
  const groups = new Map<string, Card[]>();
  const formatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  for (const card of cards) {
    const label = formatter.format(new Date(card.completedAt ?? card.updatedAt));
    groups.set(label, [...(groups.get(label) ?? []), card]);
  }
  return [...groups.entries()];
}

function formatCompletion(card: Card): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(card.completedAt ?? card.updatedAt),
  );
}
