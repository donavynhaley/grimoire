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
        cancel <kbd aria-hidden="true">esc</kbd>
      </button>
    </div>
  );
}
