import type { Chapter } from "../../shared/types";

/**
 * Formats a `YYYY-MM-DD` chapter day.
 *
 * A chapter boundary is a plain calendar day the team named, carrying no time and no zone.
 * Reading it as UTC midnight and then formatting in the reader's local zone would shift it
 * backwards for anyone west of UTC, so a chapter ending on the 15th would read as the 14th.
 * Formatting in UTC keeps the label identical to the day that is stored, for every reader.
 */
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

/**
 * The one-line "when" a chapter carries, or an empty string when it never took dates.
 *
 * Dates are optional, so a chapter without them has nothing to say here. Saying "no dates"
 * announced their absence in two places at once and made the blank case look like a defect
 * rather than a choice.
 */
export function chapterWhen(chapter: Chapter): string {
  if (chapter.state === "closed") {
    return chapter.closedAt ? `closed ${dayLabel(chapter.closedAt.slice(0, 10))}` : "closed";
  }
  if (chapter.startsOn && chapter.endsOn) return `${dayLabel(chapter.startsOn)} → ${dayLabel(chapter.endsOn)}`;
  if (chapter.endsOn) return `ends ${dayLabel(chapter.endsOn)}`;
  if (chapter.startsOn) return `from ${dayLabel(chapter.startsOn)}`;
  return "";
}
