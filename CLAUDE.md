# Working rules

## Nothing pops in

A box that changes size must travel to its new size. Sections that unfold, controls
that swap for the editor behind them, confirmations that replace the action they
guard, lists that reveal the rest of themselves — none of them may resize in a single
frame, because the jump lands under the pointer that asked for it and throws whatever
sits below down the panel.

Wrap the box that changes in `<Growing>` (`src/components/Growing.tsx`). It keeps the
class and attributes the element already had, so adopting it is a tag change and never
a layout change:

```tsx
<Growing className="dialog-section page-history">
  <button aria-expanded={open} …>History</button>
  {open && <HistoryEvents … />}
</Growing>
```

Wrap the container whose height changes, not the thing appearing inside it. The
container is the one element present in both states, so it has a height to travel
from; a child that only exists once it is open has nothing to grow out of.

`Growing` is a thin wrapper over `useHeightSwap` (`src/hooks/use-height-swap.ts`),
which shares the timing and the reduced-motion behaviour of `useFlip`: 190ms on
`cubic-bezier(0.2, 0.7, 0.2, 1)`, skipped entirely when the system asks for reduced
motion. It animates real layout rather than a transform, so everything below the box
travels with it instead of arriving first.

Two things this rule does not cover, both of which are already handled elsewhere and
should stay that way:

- **Dialogs and popovers appearing.** They are not resizing in place; they enter, and
  they get entrance animations in CSS (see `capture-tools-in`).
- **Lists whose length tracks a query**, such as search results. The changing length
  is the answer to what was typed, not a section opening.
