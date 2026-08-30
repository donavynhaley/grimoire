/**
 * While a card is held, the board says so and offers the way out, because the gaps that have
 * opened everywhere are otherwise unexplained.
 */
export function MovingBar({ onCancel, title }: { onCancel: () => void; title: string }) {
  return (
    <div className="moving-bar" role="status">
      <span>
        Moving <strong>{title}</strong> — choose where it goes
      </span>
      <button className="text-button" onClick={onCancel} type="button">
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character */}
        cancel <kbd aria-hidden="true">esc</kbd>
      </button>
    </div>
  );
}
