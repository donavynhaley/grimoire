import { useRef } from "react";
import { useHeightSwap } from "./use-height-swap";

/**
 * A box that travels between its sizes instead of jumping between them.
 *
 * Nothing in the product should change size in one frame under the pointer that
 * asked for it: a section that unfolds, a control that swaps for the editor behind
 * it, a confirmation that replaces the action it guards. Wrapping the box that
 * changes — rather than the thing appearing inside it — keeps the rule one word at
 * each site, and keeps whatever sits below travelling with it.
 *
 * The box keeps whatever class and attributes it already had, so adopting it is a
 * tag change and never a layout change.
 */
export function Growing({ children, ...props }: React.ComponentProps<"div">) {
  const box = useRef<HTMLDivElement | null>(null);
  useHeightSwap(box);
  return <div {...props} ref={box}>{children}</div>;
}
