import { useEffect } from "react";

type Options = {
  view: "work" | "ideas";
  onOpenBacklog: () => void;
  onOpenSearch: () => void;
  onViewChange: (view: "work" | "ideas") => Promise<void>;
};

/** The board's global keys: "/" opens search, B the backlog, 1 and 2 switch workspaces. */
export function useBoardShortcuts({ view, onOpenBacklog, onOpenSearch, onViewChange }: Options): void {
  useEffect(() => {
    const runShortcut = (event: KeyboardEvent) => {
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
      const target = event.target;
      // An open dialog owns the keyboard: a board shortcut fired underneath one would
      // act on a surface the reader cannot see.
      if (document.querySelector(".modal-backdrop")) return;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) {
        const isEmptyCapture =
          target instanceof HTMLInputElement &&
          (target.id === "quick-page" || target.id === "capture-idea") &&
          target.value.length === 0;
        if (event.key.toLowerCase() === "b" || !isEmptyCapture) return;
      }
      // Search reaches the whole project, so it answers from either workspace.
      if (event.key === "/") {
        event.preventDefault();
        onOpenSearch();
        return;
      }
      if (event.key.toLowerCase() === "b" && view === "work") {
        event.preventDefault();
        onOpenBacklog();
        return;
      }
      const nextView = event.key === "1" ? "work" : event.key === "2" ? "ideas" : null;
      if (!nextView) return;
      event.preventDefault();
      void onViewChange(nextView);
    };
    window.addEventListener("keydown", runShortcut);
    return () => window.removeEventListener("keydown", runShortcut);
  }, [onOpenBacklog, onOpenSearch, onViewChange, view]);
}
