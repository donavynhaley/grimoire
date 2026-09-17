import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Chapter } from "../../shared/types";
import { Growing } from "./Growing";

type Props = {
  /** The open chapter this decision is about. */
  chapter: Chapter;
  /** How many of its pages are not done, which is what the first question is for. */
  unfinished: number;
  /** Chapters still planned, in reading order; the first is where a rollover leads. */
  planned: Chapter[];
  busy: boolean;
  onDismiss: () => void;
  /** Closes the chapter, answering for its unfinished work. True once the server took it. */
  onCloseChapter: (rollover: string) => Promise<boolean>;
  onOpenChapter: (slug: string) => Promise<boolean>;
  /** Creates a chapter and answers with its slug, so the caller can carry work in or open it. */
  onCreateChapter: (name: string) => Promise<string | undefined>;
};

/**
 * The decision closing a chapter requires, asked over the settings panel rather than inside
 * the row that raised it.
 *
 * Closing used to answer itself in place: a line of bare text buttons squeezed into the
 * chapter row, where the choice that moves every unfinished page carried the same weight as
 * "cancel", and the row jumped to fit them. It is the one settings act that cannot be
 * deferred - the unfinished work has to land somewhere - so it is asked on top of the panel
 * with the panel held inert behind it, and nothing is still chosen on anyone's behalf.
 *
 * Carrying onward never depends on somebody having planned ahead. The last chapter in a
 * project had only "leave them here" and "release them" to offer, which made the end of the
 * last stretch the one place the work could not travel; naming the chapter it travels into
 * is one of the routes, and the chapter is created before the close so the pages land in it.
 *
 * The second half is what the old flow never offered. A chapter that ends is almost always a
 * chapter that hands over, so once this one is closed the same surface offers the next one -
 * open a chapter already planned, or name a new one - rather than leaving the project with
 * no open chapter and nothing saying it needs one.
 */
export function ChapterCloseOverlay({
  chapter,
  unfinished,
  planned,
  busy,
  onDismiss,
  onCloseChapter,
  onOpenChapter,
  onCreateChapter,
}: Props) {
  const [closed, setClosed] = useState(false);
  // Which name is being asked for: the chapter to carry work into, or the one to open next.
  const [naming, setNaming] = useState<"carry" | "next" | null>(null);
  const [name, setName] = useState("");
  // Where a rollover leads: the next chapter still planned, named so the choice is not blind.
  const next = planned[0];
  const others = planned.filter((candidate) => candidate.slug !== next?.slug);

  const choose = async (rollover: string) => {
    if (await onCloseChapter(rollover)) setClosed(true);
  };

  /** Names the chapter the work is carried into, makes it, then closes into it. */
  const submitCarry = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const slug = await onCreateChapter(trimmed);
    if (!slug) return;
    setName("");
    setNaming(null);
    await choose(slug);
  };

  const submitNext = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const slug = await onCreateChapter(trimmed);
    if (slug && (await onOpenChapter(slug))) onDismiss();
  };

  useNestedEscape(onDismiss);

  return (
    <div className="chapter-close-overlay">
      <Growing
        aria-labelledby="chapter-close-title"
        aria-modal="true"
        className="chapter-close-card"
        role="dialog"
      >
        {closed ? (
          <>
            <p className="eyebrow">{chapter.name} is closed</p>
            <h3 id="chapter-close-title">What comes next?</h3>
            <p className="chapter-close-note">
              {planned.length > 0
                ? "Open the chapter the work is heading into, or name a new one. Nothing opens on its own."
                : "Nothing is planned after this one. Name the next stretch, or leave the project between chapters."}
            </p>
            {naming === "next" ? (
              <ChapterNameForm
                busy={busy}
                label="Name the next chapter"
                onBack={() => setNaming(null)}
                onChange={setName}
                onSubmit={(event) => void submitNext(event)}
                submitLabel="create and open"
                value={name}
              />
            ) : (
              <>
                <div className="chapter-close-options">
                  {planned.map((candidate) => (
                    <button
                      className={`chapter-close-option${candidate.slug === next?.slug ? " lead" : ""}`}
                      disabled={busy}
                      key={candidate.slug}
                      onClick={() => void onOpenChapter(candidate.slug).then((ok) => ok && onDismiss())}
                      type="button"
                    >
                      open {candidate.name}
                    </button>
                  ))}
                  <button
                    className={`chapter-close-option${planned.length === 0 ? " lead" : ""}`}
                    disabled={busy}
                    onClick={() => setNaming("next")}
                    type="button"
                  >
                    start a new chapter
                  </button>
                </div>
                <div className="chapter-close-footer">
                  <button className="chapter-close-dismiss" disabled={busy} onClick={onDismiss} type="button">
                    not now
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <p className="eyebrow">Closing a chapter</p>
            <h3 id="chapter-close-title">Close {chapter.name}?</h3>
            <p className="chapter-close-note">
              {unfinished > 0
                ? `${unfinished} page${unfinished === 1 ? " is" : "s are"} unfinished. Say where ${unfinished === 1 ? "it goes" : "they go"} before this chapter ends.`
                : "Everything in this chapter is done."}
            </p>
            {naming === "carry" ? (
              <ChapterNameForm
                busy={busy}
                label="Name the chapter to carry them into"
                onBack={() => setNaming(null)}
                onChange={setName}
                onSubmit={(event) => void submitCarry(event)}
                submitLabel="create and carry"
                value={name}
              />
            ) : (
              <>
                {/* Nothing here happens by default. Automatic rollover is the most sprint-like
                    behaviour there is, so the unfinished pages move only because someone chose
                    one of these, and dismissing does nothing at all. */}
                <div className="chapter-close-options">
                  {unfinished > 0 && next && (
                    <button
                      className="chapter-close-option lead"
                      disabled={busy}
                      onClick={() => void choose("next")}
                      type="button"
                    >
                      roll them into {next.name}
                    </button>
                  )}
                  {unfinished > 0 &&
                    others.map((candidate) => (
                      <button
                        className="chapter-close-option"
                        disabled={busy}
                        key={candidate.slug}
                        onClick={() => void choose(candidate.slug)}
                        type="button"
                      >
                        move them to {candidate.name}
                      </button>
                    ))}
                  {/* The last chapter in a project has nowhere planned to roll into, which is
                      exactly when carrying onward matters most. The chapter is named here and
                      made before the close, so the pages land in it rather than in nothing. */}
                  {unfinished > 0 && (
                    <button
                      className={`chapter-close-option${next ? "" : " lead"}`}
                      disabled={busy}
                      onClick={() => setNaming("carry")}
                      type="button"
                    >
                      carry them into a new chapter
                    </button>
                  )}
                  <button
                    className={`chapter-close-option${unfinished > 0 ? "" : " lead"}`}
                    disabled={busy}
                    onClick={() => void choose("keep")}
                    type="button"
                  >
                    {unfinished > 0 ? "leave them here" : "close it"}
                  </button>
                  {unfinished > 0 && (
                    <button
                      className="chapter-close-option"
                      disabled={busy}
                      onClick={() => void choose("release")}
                      type="button"
                    >
                      release them
                    </button>
                  )}
                </div>
                <div className="chapter-close-footer">
                  <button className="chapter-close-dismiss" disabled={busy} onClick={onDismiss} type="button">
                    cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Growing>
    </div>
  );
}

type NameFormProps = {
  busy: boolean;
  /** What the field is for, which is the only thing separating the two uses of this form. */
  label: string;
  submitLabel: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
};

/** Naming a chapter, whether it is the one the work travels into or the one opened next. */
function ChapterNameForm({ busy, label, submitLabel, value, onChange, onSubmit, onBack }: NameFormProps) {
  return (
    <form className="chapter-close-new" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor="chapter-close-new-name">
        {label}
      </label>
      <input
        id="chapter-close-new-name"
        name="nextChapterName"
        // The caret belongs in the field the reader just asked for.
        // biome-ignore lint/a11y/noAutofocus: the field is the only reason this step exists
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        placeholder="Chapter name..."
        value={value}
      />
      <button className="primary-button compact" disabled={busy || !value.trim()} type="submit">
        {submitLabel}
      </button>
      <button className="chapter-close-dismiss" disabled={busy} onClick={onBack} type="button">
        back
      </button>
    </form>
  );
}

/**
 * Escape dismisses this decision without taking the settings drawer with it.
 *
 * The drawer answers Escape from its own window listener. This one runs in the capture phase,
 * so it hears the press first, marks it handled and stops it there - which is exactly the
 * contract use-dialog-escape documents for a nested control that answers Escape itself.
 */
function useNestedEscape(dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
}
