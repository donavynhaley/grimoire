import type { ReactNode } from "react";

type Props = {
  /**
   * The caller holds whether the question is on screen, because the answer often lives
   * outside this component: a list keeps one question open across all its rows, and some
   * neighbours hide or appear while the question stands.
   */
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** What the resting button offers, in the site's own words. */
  trigger: ReactNode;
  triggerAriaLabel?: string;
  triggerClass?: string;
  triggerDisabled?: boolean;
  /** The question asked in place of the button. */
  question: ReactNode;
  /**
   * Class for the element holding the question; left off, the question and its answers
   * stand directly in the parent's own row, spaced by the parent's own gap.
   */
  className?: string;
  confirmAriaLabel?: string;
  confirmClass?: string;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  cancelAriaLabel?: string;
  cancelClass?: string;
  cancelDisabled?: boolean;
  cancelLabel?: string;
};

/**
 * A destructive button that asks its question where it stands.
 *
 * The confirmation appears in the button's own place rather than in a modal, so the
 * question sits beside the thing it is about and a slip of the pointer costs nothing.
 * Every site keeps its own wording and classes; this only owns the swap.
 */
export function ConfirmInline({
  open,
  onOpen,
  onCancel,
  onConfirm,
  trigger,
  triggerAriaLabel,
  triggerClass,
  triggerDisabled,
  question,
  className,
  confirmAriaLabel,
  confirmClass = "danger-text",
  confirmDisabled,
  confirmLabel = "yes",
  cancelAriaLabel,
  cancelClass,
  cancelDisabled,
  cancelLabel = "no",
}: Props) {
  if (!open) {
    return (
      <button
        aria-label={triggerAriaLabel}
        className={triggerClass}
        disabled={triggerDisabled}
        onClick={onOpen}
        type="button"
      >
        {trigger}
      </button>
    );
  }
  const asked = (
    <>
      <span>{question}</span>
      <button
        aria-label={confirmAriaLabel}
        className={confirmClass}
        disabled={confirmDisabled}
        onClick={onConfirm}
        type="button"
      >
        {confirmLabel}
      </button>
      <button
        aria-label={cancelAriaLabel}
        className={cancelClass}
        disabled={cancelDisabled}
        onClick={onCancel}
        type="button"
      >
        {cancelLabel}
      </button>
    </>
  );
  return className ? <span className={className}>{asked}</span> : asked;
}
