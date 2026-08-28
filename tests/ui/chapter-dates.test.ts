import { describe, expect, it } from "vitest";
import { chapterWhen, dayLabel } from "../../src/components/chapter-dates";
import type { Chapter } from "../../shared/types";

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    slug: "first-brew",
    name: "First Brew",
    description: "",
    state: "open",
    position: 0,
    startsOn: null,
    endsOn: null,
    createdById: "user",
    createdByName: "Donavyn",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    closedAt: null,
    carriedPages: null,
    carriedEstimate: null,
    carriedTo: null,
    deliveredPages: null,
    deliveredEstimate: null,
    ...overrides,
  };
}

describe("chapter days", () => {
  /**
   * A chapter boundary is a plain day with no time and no zone. Formatting it in the reader's
   * local zone shifted it backwards for anyone west of UTC, so a chapter ending on the 15th
   * displayed as the 14th. The rendered day must always be the stored day.
   */
  it("renders the stored day, whatever the reader's timezone", () => {
    for (const day of ["2026-01-01", "2026-08-18", "2026-09-15", "2026-12-31"]) {
      const expected = String(Number(day.slice(8, 10)));
      expect(dayLabel(day)).toContain(expected);
    }
  });

  it("reads a start and an end as a range", () => {
    expect(chapterWhen(chapter({ startsOn: "2026-08-18", endsOn: "2026-09-15" }))).toBe("Aug 18 → Sep 15");
  });

  it("says what it knows when only one date was given", () => {
    expect(chapterWhen(chapter({ endsOn: "2026-09-15" }))).toBe("ends Sep 15");
    expect(chapterWhen(chapter({ startsOn: "2026-08-18" }))).toBe("from Aug 18");
  });

  it("says nothing at all when a chapter never took dates", () => {
    // Dates are optional, so their absence is not news. Announcing it made the blank case
    // read as a defect and printed the same non-fact in two places at once.
    expect(chapterWhen(chapter())).toBe("");
  });

  it("reports a closed chapter by when it closed, not by its planned end", () => {
    expect(
      chapterWhen(chapter({ state: "closed", endsOn: "2026-09-15", closedAt: "2026-09-02T11:00:00.000Z" })),
    ).toBe("closed Sep 2");
  });
});
