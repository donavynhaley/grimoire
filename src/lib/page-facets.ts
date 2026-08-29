import {
  PAGE_STATUS_LABELS,
  PAGE_STATUSES,
  type Page,
  type PageStatus,
  type ProjectCategory,
  type ProjectField,
} from "../../shared/types";
import { fieldValueText } from "./field-text";

/**
 * Which values of each property the board is narrowed to.
 *
 * A property with no entry, or an empty one, is not filtering at all. Within one property the
 * ticked values are alternatives - "Code or UI" - and across properties they accumulate, so
 * every extra tick inside a section widens the board and every new section narrows it. That is
 * the only reading under which ticking two categories can show anything: a page has one.
 */
export type FacetSelection = Record<string, string[]>;

export type FacetValue = { id: string; label: string; count: number };
export type Facet = { key: string; label: string; values: FacetValue[] };

export type FacetContext = {
  categories: ProjectCategory[];
  fields: ProjectField[];
  /** Off unless the project asked for estimates, and then no page has one to filter by. */
  estimatesEnabled: boolean;
  /** Passed in rather than read from the clock, so one pass buckets against one instant. */
  now: Date;
};

/** The answer a page gives when nobody has filled the property in. */
export const UNSET = "none";

const statusNames = PAGE_STATUS_LABELS;

const DAY = 24 * 60 * 60 * 1000;
const AGE_BUCKETS = ["today", "week", "month", "older"] as const;
const ageNames: Record<string, string> = {
  today: "today",
  week: "this week",
  month: "this month",
  older: "older",
};

const githubNames: Record<string, string> = {
  open: "PR open",
  draft: "PR draft",
  merged: "PR merged",
  closed: "PR closed",
  missing: "link broken",
  unchecked: "not checked yet",
  linked: "linked",
};

/**
 * One thing a page can be filtered by: how to read it off a page, and what to call what it says.
 *
 * Every property answers with exactly one value per page, which is what makes a tick list the
 * whole interface - there is no page that is both blocked and not, or in two columns at once.
 */
type Property = {
  key: string;
  label: string;
  valueOf: (page: Page) => string;
  labelOf: (id: string) => string;
  /** Values in the order the project already lists them; anything else sorts by count. */
  order?: string[];
};

function ageOf(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "older";
  if (then.toDateString() === now.toDateString()) return "today";
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < 7 * DAY) return "week";
  if (elapsed < 30 * DAY) return "month";
  return "older";
}

/**
 * Everything the board can be narrowed by, in the order the panel offers it.
 *
 * The project's own vocabulary comes first - its categories and its fields are what its pages
 * are actually about - and the properties every project shares follow. Assignee and chapter are
 * deliberately absent: both already have a control of their own in the same bar, and a second
 * copy here would be two places to set one thing and two places to look when it is set.
 */
function facetProperties({ categories, fields, estimatesEnabled, now }: FacetContext): Property[] {
  const categoryNames = new Map(categories.map((category) => [category.slug, category.name]));
  const properties: Property[] = [
    {
      key: "category",
      label: "Category",
      valueOf: (page) => page.category ?? UNSET,
      labelOf: (id) => (id === UNSET ? "uncategorized" : (categoryNames.get(id) ?? id)),
      order: categories.map((category) => category.slug),
    },
    {
      key: "status",
      label: "Column",
      valueOf: (page) => page.status,
      labelOf: (id) => statusNames[id as PageStatus] ?? id,
      order: [...PAGE_STATUSES],
    },
  ];

  for (const field of fields) {
    properties.push({
      key: `field:${field.key}`,
      label: field.label,
      // The value is the same text the page itself shows for it, so it is its own label and a
      // checkbox reads "yes" here exactly as it does on the tile.
      valueOf: (page) => {
        const value = page.fields[field.key];
        return value === undefined ? UNSET : fieldValueText(field, value);
      },
      labelOf: (id) => (id === UNSET ? "not set" : id),
      order: field.type === "checkbox" ? ["yes", "no"] : field.options,
    });
  }

  if (estimatesEnabled) {
    properties.push({
      key: "estimate",
      label: "Estimate",
      valueOf: (page) => (page.estimate === null ? UNSET : String(page.estimate)),
      labelOf: (id) => (id === UNSET ? "not set" : id),
      // Numbers read as numbers, so 13 sorts after 8 rather than between 1 and 2.
      order: undefined,
    });
  }

  properties.push(
    {
      key: "blocked",
      label: "Blocked",
      valueOf: (page) => (page.blockedBy.length > 0 ? "yes" : "no"),
      labelOf: (id) => (id === "yes" ? "blocked" : "not blocked"),
      order: ["yes", "no"],
    },
    {
      key: "github",
      label: "GitHub",
      valueOf: (page) => (page.github ? (page.githubStatus?.state ?? "linked") : UNSET),
      labelOf: (id) => (id === UNSET ? "not linked" : (githubNames[id] ?? id)),
      order: ["open", "draft", "merged", "closed", "missing", "unchecked", "linked"],
    },
    {
      key: "createdBy",
      label: "Created by",
      valueOf: (page) => page.createdById,
      // Only the pages carry the names, so this one is filled in where the pages are known.
      labelOf: (id) => id,
    },
    {
      key: "updated",
      label: "Last changed",
      valueOf: (page) => ageOf(page.updatedAt, now),
      labelOf: (id) => ageNames[id] ?? id,
      order: [...AGE_BUCKETS],
    },
  );

  return properties;
}

/**
 * Whether a page survives everything ticked, as one function over the whole board.
 *
 * The properties are read once here rather than per page, because a board of a thousand pages
 * would otherwise rebuild every one of them a thousand times over.
 */
export function facetPredicate(selection: FacetSelection, context: FacetContext): (page: Page) => boolean {
  const properties = facetProperties(context).filter((property) => selection[property.key]?.length);
  if (properties.length === 0) return () => true;
  return (page) => properties.every((property) => selection[property.key]!.includes(property.valueOf(page)));
}

/**
 * The sections the panel draws, with a count on every value.
 *
 * A count answers "how many pages would I have if I ticked this", so each property counts
 * against the pages that survive every *other* property - the ordinary behaviour of faceted
 * filtering, and what stops a count reading as zero for the value that is about to be the only
 * thing on the board. Pages arrive already narrowed by the controls outside this panel, so the
 * counts respect the chapter, the people, and the search too.
 *
 * A property every page answers the same way is left out entirely: a section offering the one
 * value everything already has is a filter that cannot narrow anything. That is what keeps a
 * project with no GitHub links, no estimates and no fields of its own down to the two or three
 * sections it does use. Whether a section appears is read from the whole board rather than from
 * what is left after the other ticks, so filtering never makes a section disappear out from
 * under the reader - and a property being filtered on stays whatever else happens, or its ticks
 * could not be undone.
 */
export function buildFacets(pages: Page[], selection: FacetSelection, context: FacetContext): Facet[] {
  const properties = facetProperties(context);
  const creators = new Map(pages.map((page) => [page.createdById, page.createdByName]));
  const facets: Facet[] = [];

  for (const property of properties) {
    const ticked = selection[property.key]?.length ?? 0;
    if (ticked === 0 && !worthOffering(pages, property)) continue;
    const others = properties.filter(
      (candidate) => candidate.key !== property.key && selection[candidate.key]?.length,
    );
    const candidates =
      others.length === 0
        ? pages
        : pages.filter((page) =>
            others.every((other) => selection[other.key]!.includes(other.valueOf(page))),
          );

    const counts = new Map<string, number>();
    for (const page of candidates) {
      const id = property.valueOf(page);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // A ticked value nothing matches any more still has to be shown, or it cannot be unticked.
    for (const id of selection[property.key] ?? []) if (!counts.has(id)) counts.set(id, 0);
    if (counts.size === 0) continue;

    const label = (id: string) =>
      property.key === "createdBy" ? (creators.get(id) ?? "someone who left") : property.labelOf(id);
    const values = [...counts].map(([id, count]) => ({ id, label: label(id), count }));
    values.sort(compareValues(property));
    facets.push({ key: property.key, label: property.label, values });
  }

  return facets;
}

/** Two answers is the least a property needs before ticking one of them can narrow anything. */
function worthOffering(pages: Page[], property: Property): boolean {
  const seen = new Set<string>();
  for (const page of pages) {
    seen.add(property.valueOf(page));
    if (seen.size > 1) return true;
  }
  return false;
}

/**
 * Listed values keep the project's own order, numbers count upwards, and everything else falls
 * back to what there is most of. The unfilled answer is always last, whatever the property.
 */
function compareValues(property: Property) {
  return (left: FacetValue, right: FacetValue): number => {
    if ((left.id === UNSET) !== (right.id === UNSET)) return left.id === UNSET ? 1 : -1;
    const listed = (value: FacetValue) => property.order?.indexOf(value.id) ?? -1;
    if (property.order) {
      const byOrder = rankOf(listed(left)) - rankOf(listed(right));
      if (byOrder !== 0) return byOrder;
    }
    const numbers = Number(left.id) - Number(right.id);
    if (!Number.isNaN(numbers) && numbers !== 0) return numbers;
    return right.count - left.count || left.label.localeCompare(right.label);
  };
}

/** An unlisted value sorts after every listed one rather than before all of them. */
function rankOf(position: number): number {
  return position === -1 ? Number.MAX_SAFE_INTEGER : position;
}

/** How many values are ticked in total, which is what the trigger reports. */
export function countSelected(selection: FacetSelection): number {
  return Object.values(selection).reduce((total, values) => total + values.length, 0);
}

export function toggleFacet(selection: FacetSelection, key: string, id: string): FacetSelection {
  const current = selection[key] ?? [];
  const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
  const updated = { ...selection };
  if (next.length) updated[key] = next;
  else delete updated[key];
  return updated;
}

/**
 * The selection as one URL parameter, so a filtered board is a link like every other view here.
 *
 * `category=code,ui;blocked=yes`. Only the values are escaped: a field's key is a slug this
 * project chose and never holds a separator, while a value is whatever somebody typed into a
 * text field and a comma in it must not read as the start of another one. Keys are left as
 * they are so `field:priority` stays legible in the address bar rather than arriving as
 * `field%3Apriority` on top of whatever the query string escapes on its own.
 */
export function encodeFacets(selection: FacetSelection): string {
  return Object.entries(selection)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `${key}=${values.map(encodeURIComponent).join(",")}`)
    .join(";");
}

export function decodeFacets(raw: string | null): FacetSelection {
  if (!raw) return {};
  const selection: FacetSelection = {};
  for (const part of raw.split(";")) {
    const divider = part.indexOf("=");
    if (divider === -1) continue;
    const key = part.slice(0, divider);
    const values = part
      .slice(divider + 1)
      .split(",")
      .filter(Boolean)
      .map(safeDecode);
    if (key && values.length) selection[key] = values;
  }
  return selection;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A hand-edited link with a malformed escape is still worth reading literally.
    return value;
  }
}
