import { useEffect } from "react";

export type UndoNotice = {
  actionLabel: string;
  id: number;
  message: string;
};

type Props = {
  notice: UndoNotice;
  onDismiss: () => void;
  onUndo: () => void;
};

export function UndoToast({ notice, onDismiss, onUndo }: Props) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [notice.id, onDismiss]);

  return (
    <div className="undo-toast">
      <span role="status">{notice.message}</span>
      <button aria-label={notice.actionLabel} onClick={onUndo} type="button">undo</button>
      <button aria-label="Dismiss undo" className="undo-dismiss" onClick={onDismiss} type="button">×</button>
      <span aria-hidden="true" className="undo-timer" />
    </div>
  );
}
