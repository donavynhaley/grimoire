import { type FormEvent, useState } from "react";
import type { Card, Chapter } from "../../shared/types";
import { ApiError } from "../api/client";
import { useDialogEscape } from "./use-dialog-escape";

export type ChapterActions = {
  create: (input: { name: string; startsOn?: string | null; endsOn?: string | null }) => Promise<void>;
  update: (
    slug: string,
    input: { name?: string; description?: string; startsOn?: string | null; endsOn?: string | null; state?: Chapter["state"] },
  ) => Promise<void>;
  remove: (slug: string) => Promise<void>;
};

type Props = {
  cards: Card[];
  chapters: Chapter[];
  busy: boolean;
  actions: ChapterActions;
  onClose: () => void;
};

/** The one open chapter, if the project is in one. */
function openChapter(chapters: Chapter[]): Chapter | undefined {
  return chapters.find((chapter) => chapter.state === "open");
}

export function ChaptersDialog({ cards, chapters, busy, actions, onClose }: Props) {
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const current = openChapter(chapters);

  const countIn = (slug: string) => cards.filter((card) => card.chapter === slug).length;
  const unfinishedIn = (slug: string) =>
    cards.filter((card) => card.chapter === slug && card.status !== "done").length;

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
      await actions.create({ name, startsOn: newStart || null, endsOn: newEnd || null });
      setNewName("");
      setNewStart("");
      setNewEnd("");
    }, "The chapter could not be created");
  };

  const saveName = (chapter: Chapter) => {
    const draft = drafts[chapter.slug]?.trim();
    if (draft === undefined || draft === chapter.name) return;
    if (!draft) {
      setDrafts((value) => ({ ...value, [chapter.slug]: chapter.name }));
      return;
    }
    void run(() => actions.update(chapter.slug, { name: draft }), "The chapter could not be renamed");
  };

  useDialogEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="chapters-dialog-title" aria-modal="true" className="card-dialog chapters-dialog" role="dialog">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">project setup</p>
            <h2 id="chapters-dialog-title">Chapters</h2>
          </div>
          <button aria-label="Close chapters" className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <p className="chapters-note">
          A chapter is a stretch of work with a name and, if it helps, dates. Nothing is counted, nothing rolls
          over, and closing one never moves a card.
        </p>

        <div className="chapter-manager">
          {chapters.map((chapter) => {
            const placed = countIn(chapter.slug);
            const unfinished = unfinishedIn(chapter.slug);
            return (
              <div className={`chapter-row state-${chapter.state}`} key={chapter.slug}>
                <div className="chapter-row-main">
                  <label className="sr-only" htmlFor={`chapter-name-${chapter.slug}`}>Rename {chapter.name}</label>
                  <input
                    id={`chapter-name-${chapter.slug}`}
                    name={`chapterName-${chapter.slug}`}
                    onBlur={() => saveName(chapter)}
                    onChange={(event) => setDrafts((value) => ({ ...value, [chapter.slug]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveName(chapter); } }}
                    value={drafts[chapter.slug] ?? chapter.name}
                  />
                  <span className={`chapter-state-pill ${chapter.state}`}>{chapter.state}</span>
                </div>

                <div className="chapter-row-dates">
                  <label className="sr-only" htmlFor={`chapter-start-${chapter.slug}`}>Start of {chapter.name}</label>
                  <input
                    id={`chapter-start-${chapter.slug}`}
                    name={`chapterStart-${chapter.slug}`}
                    onChange={(event) => void run(
                      () => actions.update(chapter.slug, { startsOn: event.target.value || null }),
                      "The start date could not be changed",
                    )}
                    type="date"
                    value={chapter.startsOn ?? ""}
                  />
                  <span aria-hidden="true">→</span>
                  <label className="sr-only" htmlFor={`chapter-end-${chapter.slug}`}>End of {chapter.name}</label>
                  <input
                    id={`chapter-end-${chapter.slug}`}
                    name={`chapterEnd-${chapter.slug}`}
                    onChange={(event) => void run(
                      () => actions.update(chapter.slug, { endsOn: event.target.value || null }),
                      "The end date could not be changed",
                    )}
                    type="date"
                    value={chapter.endsOn ?? ""}
                  />
                  <span className="chapter-count">{placed} card{placed === 1 ? "" : "s"}</span>
                </div>

                <div className="chapter-row-actions">
                  {chapter.state !== "open" && (
                    <button
                      disabled={busy}
                      onClick={() => void run(async () => {
                        // One chapter is open at a time, so opening this one closes the current
                        // one first. Both writes are named in the confirm above.
                        if (current && current.slug !== chapter.slug) {
                          await actions.update(current.slug, { state: "closed" });
                        }
                        await actions.update(chapter.slug, { state: "open" });
                      }, "The chapter could not be opened")}
                      title={current && current.slug !== chapter.slug ? `Closes ${current.name} first` : undefined}
                      type="button"
                    >
                      {current && current.slug !== chapter.slug ? `close ${current.name} and open` : "open"}
                    </button>
                  )}
                  {chapter.state === "open" && (
                    closing === chapter.slug ? (
                      <span className="archive-confirm">
                        <span>
                          close it?{unfinished > 0 && ` ${unfinished} unfinished card${unfinished === 1 ? "" : "s"} stay here`}
                        </span>
                        <button
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await actions.update(chapter.slug, { state: "closed" });
                            setClosing(null);
                          }, "The chapter could not be closed")}
                          type="button"
                        >yes</button>
                        <button onClick={() => setClosing(null)} type="button">no</button>
                      </span>
                    ) : (
                      <button disabled={busy} onClick={() => setClosing(chapter.slug)} type="button">close</button>
                    )
                  )}
                  {removing === chapter.slug ? (
                    <span className="archive-confirm">
                      <span>delete?{placed > 0 && ` ${placed} card${placed === 1 ? "" : "s"} lose it`}</span>
                      <button
                        aria-label={`Confirm delete ${chapter.name}`}
                        className="danger-text"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await actions.remove(chapter.slug);
                          setRemoving(null);
                        }, "The chapter could not be deleted")}
                        type="button"
                      >yes</button>
                      <button aria-label={`Cancel deleting ${chapter.name}`} onClick={() => setRemoving(null)} type="button">no</button>
                    </span>
                  ) : (
                    <button
                      aria-label={`Delete ${chapter.name}`}
                      className="danger-text"
                      onClick={() => setRemoving(chapter.slug)}
                      type="button"
                    >delete</button>
                  )}
                </div>
              </div>
            );
          })}
          {chapters.length === 0 && <p className="empty-dependencies">No chapters yet. Name the first stretch below.</p>}
        </div>

        <form className="chapter-add" onSubmit={submitCreate}>
          <span className="field-label">Add a chapter</span>
          <div className="chapter-add-row">
            <label className="sr-only" htmlFor="new-chapter-name">New chapter name</label>
            <input
              id="new-chapter-name"
              name="newChapterName"
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Chapter name..."
              value={newName}
            />
            <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">add</button>
          </div>
          <div className="chapter-add-dates">
            <label htmlFor="new-chapter-start">starts</label>
            <input
              id="new-chapter-start"
              name="newChapterStart"
              onChange={(event) => setNewStart(event.target.value)}
              type="date"
              value={newStart}
            />
            <label htmlFor="new-chapter-end">ends</label>
            <input
              id="new-chapter-end"
              name="newChapterEnd"
              onChange={(event) => setNewEnd(event.target.value)}
              type="date"
              value={newEnd}
            />
            <span className="chapter-dates-note">both optional</span>
          </div>
        </form>

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
