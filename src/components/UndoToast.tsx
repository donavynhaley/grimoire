import { useEffect } from "react";

export type UndoNotice = {
  actionLabel: string;
  id: number;
  message: string;
  /** The button's word. Most notices offer "undo"; a fresh page offers "open". */
  action?: string;
  /**
   * A single key that runs the action from the keyboard while the notice stands, shown
   * beside the button's word. It dies with the toast, so it can never act on a page the
   * reader is no longer being told about.
   */
  hotkey?: string;
};

type Props = {
  notice: UndoNotice;
  onDismiss: () => void;
  onUndo: () => void;
};

export function UndoToast({ notice, onDismiss, onUndo }: Props) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: notice.id is the trigger that restarts the countdown for a new notice; without it a second undo would inherit the first one's remaining time and vanish early
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [notice.id, onDismiss]);

  /*
   * The key lives exactly as long as the toast: mounted with it, gone with it. The guards
   * are the board shortcuts' own - no modifiers, no repeats, nothing while a dialog owns
   * the keyboard, and never while typing, because a letter mid-title is a letter, not a
   * command.
   */
  const hotkey = notice.hotkey;
  useEffect(() => {
    if (!hotkey) return;
    const runHotkey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (event.key.toLowerCase() !== hotkey) return;
      if (document.querySelector(".modal-backdrop")) return;
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) return;
      event.preventDefault();
      onUndo();
    };
    window.addEventListener("keydown", runHotkey);
    return () => window.removeEventListener("keydown", runHotkey);
  }, [hotkey, onUndo]);

  return (
    <div className="undo-toast">
      <span role="status">{notice.message}</span>
      <button aria-label={notice.actionLabel} onClick={onUndo} type="button">
        {notice.action ?? "undo"}
        {hotkey && (
          // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd is not focusable; this is a shortcut glyph beside the label inside a focusable button, and hiding it is what keeps the button announcing its name rather than its name and a stray character
          <kbd aria-hidden="true">{hotkey}</kbd>
        )}
      </button>
      <button aria-label="Dismiss undo" className="undo-dismiss" onClick={onDismiss} type="button">
        ×
      </button>
      <span aria-hidden="true" className="undo-timer" />
    </div>
  );
}
