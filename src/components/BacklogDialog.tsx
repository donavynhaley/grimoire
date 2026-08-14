import { useEffect, useMemo, useState } from "react";
import { type Card, type CardCategory, type Chapter, type Member, type ProjectCategory } from "../../shared/types";
import { categoryDisplay, categoryStyle } from "./category-style";
import { plainTextFromMarkdown } from "./markdown-text";

type Props = {
  allCards: Card[];
  busy: boolean;
  cards: Card[];
  categories: ProjectCategory[];
  chapters: Chapter[];
  members: Member[];
  /** The chapter the board is looking at, which is the one a pull adds to. */
  targetChapter: string | null;
  onClose: () => void;
  onMoveToNext: (id: string) => Promise<void>;
  onOpenCard: (id: string) => void;
  onSetChapter: (id: string, chapter: string | null) => Promise<void>;
};

/** Which chapter a library row must belong to: any, a named one, or none yet. */
type ChapterChoice = string | null | "unplaced";

export function BacklogDialog({ allCards, busy, cards, categories, chapters, members, targetChapter, onClose, onMoveToNext, onOpenCard, onSetChapter }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CardCategory | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [chapterFilter, setChapterFilter] = useState<ChapterChoice>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const target = chapters.find((chapter) => chapter.slug === targetChapter);
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
        if (chapterFilter === "unplaced" && card.chapter !== null) return false;
        if (chapterFilter !== null && chapterFilter !== "unplaced" && card.chapter !== chapterFilter) return false;
        return !normalizedQuery || cardText(card).includes(normalizedQuery);
      })
      .sort((left, right) => left.position - right.position),
    [allCards, blockedOnly, cards, category, chapterFilter, normalizedQuery, person],
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
            <p>
              {cards.length} accepted card{cards.length === 1 ? "" : "s"} outside the active deck
              {target && ` · ${cards.filter((card) => card.chapter === target.slug).length} already in ${target.name}`}
            </p>
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
          {chapters.length > 0 && (
            <div aria-label="Backlog chapters" className="library-filters chapter-filters">
              <span className="library-filter-label">chapter</span>
              <button aria-pressed={chapterFilter === null} className={chapterFilter === null ? "active" : ""} onClick={() => setChapterFilter(null)} type="button">any</button>
              {chapters.map((chapter) => (
                <button
                  aria-pressed={chapterFilter === chapter.slug}
                  className={chapterFilter === chapter.slug ? "active" : ""}
                  key={chapter.slug}
                  onClick={() => setChapterFilter(chapterFilter === chapter.slug ? null : chapter.slug)}
                  type="button"
                >{chapter.name}</button>
              ))}
              <button aria-pressed={chapterFilter === "unplaced"} className={chapterFilter === "unplaced" ? "active" : ""} onClick={() => setChapterFilter(chapterFilter === "unplaced" ? null : "unplaced")} type="button">no chapter</button>
            </div>
          )}
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
                {card.description && <p>{plainTextFromMarkdown(card.description)}</p>}
                <span>{card.assigneeName ?? "unassigned"}</span>
              </button>
              <div className="library-card-actions">
                {/* Placing a card in a chapter leaves it in the Backlog. Committing to a
                    stretch and being ready to start are separate decisions, which is what
                    keeps Up Next the small set someone can pick up now. */}
                {target && (
                  card.chapter === target.slug ? (
                    <button
                      aria-label={`Remove ${card.title} from ${target.name}`}
                      className="library-chapter in"
                      disabled={busy}
                      onClick={() => void onSetChapter(card.id, null)}
                      type="button"
                    >in {target.name}</button>
                  ) : (
                    <button
                      aria-label={`Add ${card.title} to ${target.name}`}
                      className="library-chapter"
                      disabled={busy}
                      onClick={() => void onSetChapter(card.id, target.slug)}
                      type="button"
                    >+ {target.name}</button>
                  )
                )}
                <button
                  aria-label={`Move ${card.title} to Up Next`}
                  className="library-promote"
                  disabled={busy}
                  onClick={() => void onMoveToNext(card.id)}
                  type="button"
                >up next <span aria-hidden="true">→</span></button>
              </div>
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
