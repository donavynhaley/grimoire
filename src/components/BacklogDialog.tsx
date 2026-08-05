import { useEffect, useMemo, useState } from "react";
import { type Card, type CardCategory, type Member, type ProjectCategory } from "../../shared/types";
import { categoryDisplay, categoryStyle } from "./category-style";

type Props = {
  allCards: Card[];
  busy: boolean;
  cards: Card[];
  categories: ProjectCategory[];
  members: Member[];
  onClose: () => void;
  onMoveToNext: (id: string) => Promise<void>;
  onOpenCard: (id: string) => void;
};

export function BacklogDialog({ allCards, busy, cards, categories, members, onClose, onMoveToNext, onOpenCard }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CardCategory | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [blockedOnly, setBlockedOnly] = useState(false);
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
        if (blockedOnly && !isBlocked(card, allCards)) return false;
        return !normalizedQuery || cardText(card).includes(normalizedQuery);
      })
      .sort((left, right) => left.position - right.position),
    [allCards, blockedOnly, cards, category, normalizedQuery, person],
  );

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
      <section aria-labelledby="backlog-dialog-title" aria-modal="true" className="library-dialog" role="dialog">
        <header className="dialog-header library-header">
          <div>
            <p className="eyebrow">work library</p>
            <h2 id="backlog-dialog-title">Backlog</h2>
            <p>{cards.length} accepted card{cards.length === 1 ? "" : "s"} outside the active deck</p>
          </div>
          <button aria-label="Close backlog" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="library-tools">
          <label className="library-search">
            <span className="sr-only">Search backlog</span>
            <input
              aria-label="Search backlog"
              autoFocus
              id="backlog-search"
              name="backlogSearch"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the backlog..."
              type="search"
              value={query}
            />
          </label>
          <div aria-label="Backlog filters" className="library-filters">
            <button aria-pressed={blockedOnly} className={blockedOnly ? "active" : ""} onClick={() => setBlockedOnly((value) => !value)} type="button">blocked</button>
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
            <div aria-label="Backlog categories" className="library-filters category-filters">
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

        <div className="library-results" aria-live="polite">
          {visibleCards.map((card) => (
            <article className={`library-card ${card.category ? "" : "category-none"}`} key={card.id} style={categoryStyle(categories, card.category)}>
              <button className="library-card-main" onClick={() => onOpenCard(card.id)} type="button">
                <span className="library-card-signals">
                  {card.category && <span className="category-pill">{categoryDisplay(categories, card.category)}</span>}
                  {isBlocked(card, allCards) && <span className="card-blocked">blocked</span>}
                </span>
                <strong>{card.title}</strong>
                {card.description && <p>{card.description}</p>}
                <span>{card.assigneeName ?? "unassigned"}</span>
              </button>
              <button
                aria-label={`Move ${card.title} to Up Next`}
                className="library-promote"
                disabled={busy}
                onClick={() => void onMoveToNext(card.id)}
                type="button"
              >up next <span aria-hidden="true">→</span></button>
            </article>
          ))}
          {visibleCards.length === 0 && (
            <div className="library-empty">
              <strong>{cards.length === 0 ? "The backlog is clear." : "No cards match these filters."}</strong>
              <span>{cards.length === 0 ? "Capture work above whenever something earns a place here." : "Try a broader search or remove a filter."}</span>
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

function isBlocked(card: Card, allCards: Card[]): boolean {
  return card.blockedBy.some((id) => allCards.some((candidate) => candidate.id === id && candidate.status !== "done"));
}
