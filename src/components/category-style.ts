import type { CSSProperties } from "react";
import type { ProjectCategory } from "../../shared/types";

export function categoryDisplay(categories: ProjectCategory[], slug: string | null): string {
  if (!slug) return "uncategorized";
  return categories.find((category) => category.slug === slug)?.name ?? slug;
}

export function categoryStyle(categories: ProjectCategory[], slug: string | null): CSSProperties | undefined {
  const color = slug ? categories.find((category) => category.slug === slug)?.color : undefined;
  return color ? categoryColorStyle(color) : undefined;
}

/** For the sites that already hold the colour itself - a palette, a search hit - and have no slug to look up. */
export function categoryColorStyle(color: string): CSSProperties {
  return { "--category-color": color } as CSSProperties;
}
