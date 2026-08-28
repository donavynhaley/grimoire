import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Stamps every rendered element with the span of Markdown source it came from,
 * as `data-sourcepos="start-end"` character offsets.
 *
 * This is what lets a click on the rendered notes land the caret on the same
 * words in the editor: the element under the pointer names the slice of source
 * it was drawn from, and the clicked text is found inside that slice instead of
 * anywhere in the document. Nodes a plugin invented (Obsidian embeds) carry no
 * position and are simply left unstamped; a click on them falls back to their
 * nearest stamped ancestor.
 */
export function rehypeSourceOffsets() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      node.properties["data-sourcepos"] = `${start}-${end}`;
    });
  };
}

/**
 * Where in the Markdown source a click on the rendered view landed.
 *
 * The caret position under the pointer names a text node and an offset inside
 * it; the nearest stamped ancestor bounds the search to the slice of source it
 * was rendered from. Within that slice the node's text is located literally -
 * a paragraph's worth of source is small enough that the match is almost always
 * unique - and when the exact text is not found (the syntax rewrote it), the
 * words immediately around the click are tried before giving up on the slice.
 *
 * Returns null when the click cannot be placed, and the caller keeps its
 * caret-at-the-end behaviour.
 */
export function sourceOffsetFromPoint(
  view: HTMLElement,
  source: string,
  x: number,
  y: number,
): number | null {
  const caret = caretFromPoint(x, y);
  if (!caret) return null;

  const anchor = caret.node instanceof Text ? caret.node.parentElement : (caret.node as HTMLElement);
  const stamped = anchor?.closest<HTMLElement>("[data-sourcepos]");
  if (!stamped || !view.contains(stamped)) return null;

  const range = stamped.dataset.sourcepos?.match(/^(\d+)-(\d+)$/);
  if (!range) return null;
  const sliceStart = Number(range[1]);
  const slice = source.slice(sliceStart, Number(range[2]));

  if (!(caret.node instanceof Text)) return sliceStart;

  const text = caret.node.data;
  const exact = slice.indexOf(text);
  if (exact !== -1) return sliceStart + exact + caret.offset;

  // The source spelled this text differently somewhere; the words right around
  // the click are the part that has to match for the caret to feel placed.
  const nearby = text.slice(Math.max(0, caret.offset - 12), caret.offset + 12);
  const found = nearby ? slice.indexOf(nearby) : -1;
  if (found !== -1) return sliceStart + found + Math.min(caret.offset, 12);

  return sliceStart;
}

/** The DOM position under a point, through whichever API this browser has. */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}
