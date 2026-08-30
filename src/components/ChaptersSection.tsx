import { type FormEvent, useState } from "react";
import type { Chapter, ChapterVelocity, Page } from "../../shared/types";
import type { SettingsRun } from "../hooks/use-settings-action";
import { chapterWhen, dayLabel } from "../lib/chapter-dates";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";

export type ChapterActions = {
  create: (input: { name: string; startsOn?: string | null; endsOn?: string | null }) => Promise<void>;
  /** Closes a chapter and says what becomes of the work it did not finish. */
  close: (slug: string, rollover: "next" | "release" | "keep" | string) => Promise<void>;
  update: (
    slug: string,
    input: {
      name?: string;
      description?: string;
      startsOn?: string | null;
      endsOn?: string | null;
      state?: Chapter["state"];
    },
  ) => Promise<void>;
  remove: (slug: string) => Promise<void>;
};

type Props = {
  pages: Page[];
  chapters: Chapter[];
  /** Per-chapter totals; empty when either chapters or estimates are switched off. */
  velocity: ChapterVelocity[];
  busy: boolean;
  actions: ChapterActions;
  chaptersEnabled: boolean;
  /** Members read the chapters; only an owner runs them. */
  canManage: boolean;
  onSetChaptersEnabled: (enabled: boolean) => Promise<void>;
  onSetPageChapter: (id: string, chapter: string | null) => Promise<void>;
  run: SettingsRun;
};

/** The one open chapter, if the project is in one. */
function openChapter(chapters: Chapter[]): Chapter | undefined {
  return chapters.find((chapter) => chapter.state === "open");
}

export function ChaptersSection({
  pages,
  chapters,
  velocity,
  busy,
  actions,
  chaptersEnabled,
  canManage,
  onSetChaptersEnabled,
  onSetPageChapter,
  run,
}: Props) {
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [descriptionDrafts, setDescriptionDrafts] = useState<Record<string, string>>({});
  // Dates draft locally and commit on blur: a typed date used to fire a save per keystroke.
  const [dateDrafts, setDateDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const current = openChapter(chapters);
  const placed = pages.filter((page) => page.chapter !== null).length;

  const countIn = (slug: string) => pages.filter((page) => page.chapter === slug).length;
  const unfinishedIn = (slug: string) =>
    pages.filter((page) => page.chapter === slug && page.status !== "done").length;
  const plannedChapters = chapters.filter((chapter) => chapter.state === "planned");

  const close = async (slug: string) => {
    await actions.update(slug, { state: "closed" });
    setClosing(null);
  };

  /**
   * Moves only the pages that did not land, leaving the finished ones as the record of what
   * the chapter delivered.
   */
  const moveUnfinished = async (from: string, to: string | null) => {
    for (const page of pages.filter((value) => value.chapter === from && value.status !== "done")) {
      await onSetPageChapter(page.id, to);
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

  const saveDescription = (chapter: Chapter) => {
    const draft = descriptionDrafts[chapter.slug];
    if (draft === undefined || draft.trim() === chapter.description) return;
    void run(
      () => actions.update(chapter.slug, { description: draft.trim() }),
      "The chapter's intent could not be saved",
    );
  };

  const dateKey = (slug: string, side: "startsOn" | "endsOn") => `${slug}/${side}`;
  const saveDate = (chapter: Chapter, side: "startsOn" | "endsOn") => {
    const draft = dateDrafts[dateKey(chapter.slug, side)];
    if (draft === undefined || draft === (chapter[side] ?? "")) return;
    const failure =
      side === "startsOn" ? "The start date could not be changed" : "The end date could not be changed";
    void run(() => actions.update(chapter.slug, { [side]: draft || null }), failure);
  };

  const gate = canManage ? (
    <Growing className="settings-row chapters-gate">
      <div className="settings-row-top">
        <span className="field-label">Chapters</span>
        <label className="settings-toggle">
          <input
            aria-label="Chapters"
            checked={chaptersEnabled}
            disabled={busy}
            name="chaptersEnabled"
            onChange={(event) =>
              void run(
                () => onSetChaptersEnabled(event.target.checked),
                "The chapters setting could not be changed",
              )
            }
            type="checkbox"
          />
          <span aria-hidden="true" className="settings-knob" />
          <span className="settings-toggle-label">{chaptersEnabled ? "on" : "off"}</span>
        </label>
      </div>
      <p className="settings-summary">
        {chaptersEnabled
          ? "Turning chapters off hides them without deleting anything; turning them back on restores exactly what was there."
          : "Group pages into named stretches of work. No points, no rollover."}
      </p>
    </Growing>
  ) : null;

  if (!chaptersEnabled) {
    return (
      <div className="settings-section">
        {gate ?? <p className="settings-summary">This project does not use chapters.</p>}
      </div>
    );
  }

  return (
    <div className="settings-section">
      {gate}
      <p className="settings-summary chapters-standing">
        {current ? (
          <>
            Open: {current.name}
            {current.startsOn && current.endsOn
              ? ` · ${dayLabel(current.startsOn)} → ${dayLabel(current.endsOn)}`
              : current.endsOn
                ? ` · ends ${dayLabel(current.endsOn)}`
                : ""}
          </>
        ) : (
          "No chapter open right now."
        )}{" "}
        · {chapters.length} chapter{chapters.length === 1 ? "" : "s"} · {placed} page{placed === 1 ? "" : "s"}{" "}
        placed
      </p>

      {!canManage ? (
        <ul className="settings-readonly-list">
          {chapters.map((chapter) => (
            <li key={chapter.slug}>
              {chapter.name}
              <span className={`chapter-state-pill ${chapter.state}`}>{chapter.state}</span>
              {chapterWhen(chapter) && <span className="settings-summary">{chapterWhen(chapter)}</span>}
              {chapter.description && <span className="settings-summary">{chapter.description}</span>}
            </li>
          ))}
          {chapters.length === 0 && <li className="settings-summary">No chapters yet.</li>}
        </ul>
      ) : (
        <>
          <p className="chapters-note">
            A chapter is a stretch of work with a name and, if it helps, dates. Nothing is estimated on
            anyone&apos;s behalf and nothing is forecast; with estimates on, a chapter adds up what it
            delivered. Closing one asks what should happen to the work it did not finish, and moves a page
            only because somebody said so.
          </p>

          <div className="chapter-manager">
            {chapters.map((chapter) => {
              const placedIn = countIn(chapter.slug);
              const unfinished = unfinishedIn(chapter.slug);
              // Where a rollover would send the work: the next chapter still planned.
              const nextPlanned = plannedChapters.find((candidate) => candidate.slug !== chapter.slug);
              const chapterVelocity = velocity.find((entry) => entry.slug === chapter.slug);
              return (
                <Growing className={`chapter-row state-${chapter.state}`} key={chapter.slug}>
                  {(chapterVelocity || chapter.carriedPages !== null) && (
                    <p className="chapter-velocity">
                      {chapterVelocity && (
                        <>
                          {/* Both readings, because a team that estimates only some of its
                              work still has a page count, and neither number implies the
                              other. */}
                          <strong>{chapterVelocity.donePages}</strong> page
                          {chapterVelocity.donePages === 1 ? "" : "s"}
                          {" · "}
                          <strong>{chapterVelocity.doneEstimate}</strong> delivered
                          {chapterVelocity.openPages > 0 && (
                            <>
                              {" "}
                              · {chapterVelocity.openPages} still open ({chapterVelocity.openEstimate})
                            </>
                          )}
                          {chapterVelocity.unestimatedPages > 0 && (
                            <>
                              {" "}
                              · <em>{chapterVelocity.unestimatedPages} unestimated</em>
                            </>
                          )}
                        </>
                      )}
                      {chapter.carriedPages !== null && chapter.carriedPages > 0 && (
                        <>
                          {chapterVelocity && " · "}
                          carried {chapter.carriedPages} page{chapter.carriedPages === 1 ? "" : "s"}
                          {chapter.carriedEstimate ? ` (${chapter.carriedEstimate})` : ""}
                          {chapter.carriedTo
                            ? ` to ${chapters.find((c) => c.slug === chapter.carriedTo)?.name ?? chapter.carriedTo}`
                            : " onward"}
                        </>
                      )}
                      {chapterVelocity?.recorded && (
                        <span className="chapter-velocity-sealed" title="Counted when this chapter closed">
                          {" "}
                          · as closed
                        </span>
                      )}
                    </p>
                  )}
                  <div className="chapter-row-main">
                    <label className="sr-only" htmlFor={`chapter-name-${chapter.slug}`}>
                      Rename {chapter.name}
                    </label>
                    <input
                      id={`chapter-name-${chapter.slug}`}
                      name={`chapterName-${chapter.slug}`}
                      onBlur={() => saveName(chapter)}
                      onChange={(event) =>
                        setDrafts((value) => ({ ...value, [chapter.slug]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveName(chapter);
                        }
                      }}
                      value={drafts[chapter.slug] ?? chapter.name}
                    />
                    <span className={`chapter-state-pill ${chapter.state}`}>{chapter.state}</span>
                  </div>

                  <div className="chapter-row-intent">
                    <label className="sr-only" htmlFor={`chapter-intent-${chapter.slug}`}>
                      What {chapter.name} is for
                    </label>
                    <textarea
                      id={`chapter-intent-${chapter.slug}`}
                      name={`chapterIntent-${chapter.slug}`}
                      onBlur={() => saveDescription(chapter)}
                      onChange={(event) =>
                        setDescriptionDrafts((value) => ({ ...value, [chapter.slug]: event.target.value }))
                      }
                      placeholder="What is this stretch for?"
                      rows={2}
                      value={descriptionDrafts[chapter.slug] ?? chapter.description}
                    />
                  </div>

                  <div className="chapter-row-dates">
                    <label className="sr-only" htmlFor={`chapter-start-${chapter.slug}`}>
                      Start of {chapter.name}
                    </label>
                    <input
                      id={`chapter-start-${chapter.slug}`}
                      name={`chapterStart-${chapter.slug}`}
                      onBlur={() => saveDate(chapter, "startsOn")}
                      onChange={(event) =>
                        setDateDrafts((value) => ({
                          ...value,
                          [dateKey(chapter.slug, "startsOn")]: event.target.value,
                        }))
                      }
                      type="date"
                      value={dateDrafts[dateKey(chapter.slug, "startsOn")] ?? chapter.startsOn ?? ""}
                    />
                    <span aria-hidden="true">→</span>
                    <label className="sr-only" htmlFor={`chapter-end-${chapter.slug}`}>
                      End of {chapter.name}
                    </label>
                    <input
                      id={`chapter-end-${chapter.slug}`}
                      name={`chapterEnd-${chapter.slug}`}
                      onBlur={() => saveDate(chapter, "endsOn")}
                      onChange={(event) =>
                        setDateDrafts((value) => ({
                          ...value,
                          [dateKey(chapter.slug, "endsOn")]: event.target.value,
                        }))
                      }
                      type="date"
                      value={dateDrafts[dateKey(chapter.slug, "endsOn")] ?? chapter.endsOn ?? ""}
                    />
                    <span className="chapter-count">
                      {placedIn} page{placedIn === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="chapter-row-actions">
                    {chapter.state !== "open" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            // One chapter is open at a time, so opening this one closes the current
                            // one first. Both writes are named in the confirm above.
                            if (current && current.slug !== chapter.slug) {
                              await actions.update(current.slug, { state: "closed" });
                            }
                            await actions.update(chapter.slug, { state: "open" });
                          }, "The chapter could not be opened")
                        }
                        title={
                          current && current.slug !== chapter.slug
                            ? `Closes ${current.name} first`
                            : undefined
                        }
                        type="button"
                      >
                        {current && current.slug !== chapter.slug ? `close ${current.name} and open` : "open"}
                      </button>
                    )}
                    {chapter.state === "open" &&
                      (closing === chapter.slug ? (
                        <div className="chapter-close">
                          <p className="chapter-close-question">
                            Close {chapter.name}?
                            {unfinished > 0 &&
                              ` ${unfinished} page${unfinished === 1 ? " is" : "s are"} unfinished.`}
                          </p>
                          {/* Nothing here happens by default. Automatic rollover is the most
                              sprint-like behaviour there is, so the unfinished pages move only
                              because someone chose one of these, and dismissing does nothing. */}
                          <div className="chapter-close-choices">
                            {/*
                              Rolling the work onward leads, because it is what a team
                              closing a stretch of work almost always means - but it is still
                              a choice somebody makes, never a thing that happens to them.
                            */}
                            {unfinished > 0 && nextPlanned && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () => actions.close(chapter.slug, "next"),
                                    "The chapter could not be closed",
                                  )
                                }
                                type="button"
                              >
                                roll them into {nextPlanned.name}
                              </button>
                            )}
                            <button
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => actions.close(chapter.slug, "keep"),
                                  "The chapter could not be closed",
                                )
                              }
                              type="button"
                            >
                              {unfinished > 0 ? "leave them here" : "close it"}
                            </button>
                            {unfinished > 0 &&
                              plannedChapters
                                .filter(
                                  (candidate) =>
                                    candidate.slug !== chapter.slug && candidate.slug !== nextPlanned?.slug,
                                )
                                .map((candidate) => (
                                  <button
                                    disabled={busy}
                                    key={candidate.slug}
                                    onClick={() =>
                                      void run(
                                        () => actions.close(chapter.slug, candidate.slug),
                                        "The pages could not be moved",
                                      )
                                    }
                                    type="button"
                                  >
                                    move them to {candidate.name}
                                  </button>
                                ))}
                            {unfinished > 0 && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () => actions.close(chapter.slug, "release"),
                                    "The pages could not be released",
                                  )
                                }
                                type="button"
                              >
                                release them
                              </button>
                            )}
                            <button onClick={() => setClosing(null)} type="button">
                              cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button disabled={busy} onClick={() => setClosing(chapter.slug)} type="button">
                          close
                        </button>
                      ))}
                    <ConfirmInline
                      cancelAriaLabel={`Cancel deleting ${chapter.name}`}
                      className="archive-confirm"
                      confirmAriaLabel={`Confirm delete ${chapter.name}`}
                      confirmDisabled={busy}
                      onCancel={() => setRemoving(null)}
                      onConfirm={() =>
                        void run(async () => {
                          await actions.remove(chapter.slug);
                          setRemoving(null);
                        }, "The chapter could not be deleted")
                      }
                      onOpen={() => setRemoving(chapter.slug)}
                      open={removing === chapter.slug}
                      question={
                        <>delete?{placedIn > 0 && ` ${placedIn} page${placedIn === 1 ? "" : "s"} lose it`}</>
                      }
                      trigger="delete"
                      triggerAriaLabel={`Delete ${chapter.name}`}
                      triggerClass="danger-text"
                    />
                  </div>
                </Growing>
              );
            })}
            {chapters.length === 0 && (
              <p className="empty-dependencies">No chapters yet. Name the first stretch below.</p>
            )}
          </div>

          <form className="chapter-add" onSubmit={submitCreate}>
            <span className="field-label">Add a chapter</span>
            <div className="chapter-add-row">
              <label className="sr-only" htmlFor="new-chapter-name">
                New chapter name
              </label>
              <input
                id="new-chapter-name"
                name="newChapterName"
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Chapter name..."
                value={newName}
              />
              <button className="primary-button compact" disabled={busy || !newName.trim()} type="submit">
                add
              </button>
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
        </>
      )}
    </div>
  );
}
