# Grimoire UI standards

How interface work is built here. The law is in `docs/coding-standards.md` §5 — the
`UI-*` standards, cited here by ID — and this document is the practitioner's half:
the patterns, the components that carry them, and the reasons, at the altitude of
someone about to write a component.

## Nothing pops in (UI-1)

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
from; a child that only exists once it is open has nothing to grow out of. Where no
such container exists — the away digest leaving on dismissal — give the traveller a
permanent slot to travel through, and make the slot a flex column so the margins it
wears are part of what gets measured (`away-digest-slot`).

`Growing` is a thin wrapper over `useHeightSwap` (`src/hooks/use-height-swap.ts`),
which shares the timing and the reduced-motion behaviour of `useFlip`: 190ms on
`cubic-bezier(0.2, 0.7, 0.2, 1)`, skipped entirely when the system asks for reduced
motion. It animates real layout rather than a transform, so everything below the box
travels with it instead of arriving first.

Two things this rule does not cover, both of which are already handled elsewhere and
should stay that way:

- **Dialogs and popovers appearing.** They are not resizing in place; they enter, and
  they get entrance animations in CSS (see `capture-tools-in`), each with its own
  `prefers-reduced-motion` override.
- **Lists whose length tracks a query**, such as search results. The changing length
  is the answer to what was typed, not a section opening.

Reordering inside a list is `useFlip` on the list container, with elements opting in
through `data-flip-id`. Layout motion is always the Web Animations API from a
`useLayoutEffect`, never a CSS transition — a transition animates from wherever the
browser last painted, which after a reorder is the wrong place.

## Dialogs (UI-5)

`Drawer` (`src/components/Drawer.tsx`) is the one overlay shell: a centred dialog on
a fine pointer, a full-height swipe-dismissable sheet on a coarse one. It owns the
whole modal contract — Escape through `use-dialog-escape` (a nested control that
handled its own Escape stops propagation, so the dialog only hears presses nothing
else wanted), focus into the panel on open, Tab held inside while it is open, and
focus handed back to the opener on close. A dialog never re-implements any of that,
and never adds a second window Escape listener on top.

The header is always the same shape: an eyebrow, an `h2` the panel is labelled by,
and an icon close button. Destructive actions confirm in place through
`<ConfirmInline>` — the question replaces the button that asked it, inside a
`Growing` container, never in a browser confirm or a second dialog.

## Accessibility is the markup, not a pass (UI-5)

Interactive things are buttons. Disclosure state is `aria-expanded`, toggle state is
`aria-pressed`, the current place is `aria-current`. Unlabelled inputs get an
`sr-only` label; icon-only controls get an `aria-label`. Errors are `role="alert"`,
transient outcomes are `role="status"` — and one act gets one status voice, never a
local line and a shared strip both announcing it.

A listbox contains options and nothing else — the header and the search field are
neighbours outside it — and `aria-selected` follows the row the keyboard is on, the
same row `aria-activedescendant` names. The stored value is a visual mark, not the
selection.

Autofocus follows `use-typing-focus`: the caret lands immediately at a desk, and
waits on a coarse pointer, where a keyboard rising over a just-opened board costs
more than it saves. Touch targets grow to 44px under the coarse-pointer media query.

## The server's answer is the truth (UI-2, UI-7, UI-8)

After a mutation the client reloads canonical state; live updates invalidate and
reload rather than merging patches. The one optimistic exception is the drag
(`src/lib/optimistic-page.ts`), and it rolls back on any refusal that is not a
content conflict.

All HTTP goes through `src/api/client.ts`, and all mutations go through the
`perform` family in `App.tsx` — that is what keeps `busy`, error surfacing, and the
reload-after-write contract true everywhere. The one sanctioned exception outside
that door is a plain `fetch` of a static asset, which is not an API call.

Effects follow the codebase's own best patterns: URL parameters are written from the
event handlers that change the state (mount-time reads and reconciliation stay
effects); every async loader carries the `alive` unmount guard; layout
read-then-write work uses `useLayoutEffect`.

## CSS (UI-6)

One `src/styles.css`, organized under section banners, in kebab-case classes with
state as a bare adjective always qualified by its parent (`.board-page.unseen`).
ARIA state doubles as the styling hook — `[aria-expanded="true"]` — rather than a
duplicate class. Colours and the other twice-repeated values are `:root` tokens;
everything is sized in `rem`; category colour crosses from React as the
`--category-color` custom property, which is the single approved inline-style
pattern. A class removed from the last TSX file leaves the CSS the same day.

## Where interface code lives (NAME-4)

`src/components/` holds components, `src/hooks/` holds hooks, `src/lib/` holds pure
helpers. A component's private helper stays in its file until a second file needs
it; then it moves to the directory its kind belongs in.
