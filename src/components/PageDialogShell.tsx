import { type ComponentProps, useCallback, useLayoutEffect, useRef, useState } from "react";
import { usePageMotion } from "../hooks/use-page-motion";
import { pageLink } from "../lib/page-link";
import { deferComponent } from "./Deferred";
import { Drawer } from "./Drawer";
import { Growing } from "./Growing";

type EditorProps = ComponentProps<typeof import("./PageDialog")["PageDialog"]>;
type Props = Omit<EditorProps, "registerCloseGuard" | "registerFileReceiver"> & {
  onClose: () => void;
  /** Says "Link copied" in the board's toast, so the header never moves to say it. */
  onNotify: (message: string) => void;
  /** The link names the board the page belongs to as well as the page. */
  projectId: string;
};

const PageDialog = deferComponent<EditorProps>(
  () => import("./PageDialog").then((module) => ({ default: module.PageDialog })),
  { exportName: "PageDialog", label: "page editor", dialogBody: true },
);

/** Keep one modal alive across the feature download, editing, and its saved exit. */
export function PageDialogShell({ onClose, onNotify, onOpenPage, projectId, ...props }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const fileReceiver = useRef<((files: File[]) => void) | null>(null);
  const [acceptsFiles, setAcceptsFiles] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  /* "" while nothing has been copied; the link itself once the clipboard refused it. */
  const [fallbackLink, setFallbackLink] = useState("");
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const registerCloseGuard = useCallback((flush: () => Promise<boolean>) => {
    guard.current = flush;
    setReady(true);
    return () => {
      guard.current = null;
    };
  }, []);

  const registerFileReceiver = useCallback((receive: (files: File[]) => void) => {
    fileReceiver.current = receive;
    setAcceptsFiles(true);
    return () => {
      fileReceiver.current = null;
      setAcceptsFiles(false);
      setDropActive(false);
      dragDepth.current = 0;
    };
  }, []);

  /**
   * Copies the page's own link, and does nothing else.
   *
   * A person copying is a person handing the page on: nothing starts, nothing is assigned
   * and nothing is recorded, so this never reaches the server. When the clipboard is refused
   * - an insecure origin, a permission denied - the link is shown instead of an error,
   * because selecting it by hand still works and that is the same answer the agent token's
   * own copy gives.
   */
  const copyLink = async () => {
    const link = pageLink({ origin: window.location.origin, pageId: props.page.id, projectId });
    try {
      await navigator.clipboard.writeText(link);
      setFallbackLink("");
      // The receipt is the board's toast rather than a line in the header: a line would push
      // the page down to say something that is over the moment it is read (UI-1).
      onNotify("Link copied");
    } catch {
      setFallbackLink(link);
    }
  };

  const close = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (guard.current && !(await guard.current())) {
        pending.current = false;
        return;
      }
      if (alive.current) setClosing(true);
    } catch {
      pending.current = false;
    }
  };

  /**
   * Leaving this page for another one - a blocker followed from the rail.
   *
   * It is a close and an open in one gesture, so it takes the same road out the close
   * button takes: whatever is still unsaved is written first, and a refusal - an emptied
   * title, a teammate's edit waiting to be settled - keeps this page on screen rather
   * than discarding the draft on the way to another one. The editor starts a new draft
   * whenever the record changes and nothing survives that switch, so asking first is the
   * only thing standing between a half-typed note and silence.
   *
   * Arriving is then an ordinary open: the board keys this shell by page, so the one for
   * the blocker grows out of the blocker's own tile exactly as a click on the board would.
   */
  const openPage = async (id: string) => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (guard.current && !(await guard.current())) {
        pending.current = false;
        return;
      }
      if (alive.current) onOpenPage(id);
      else pending.current = false;
    } catch {
      pending.current = false;
    }
  };

  // The motion owns the duration, and dismissal waits on it rather than on a second timer.
  // Reduced motion has no animation to wait for and so adds no exit delay.
  usePageMotion(shell, {
    originId: props.page.id,
    closing,
    onExited: useCallback(() => onCloseRef.current(), []),
  });

  return (
    <div className={`page-modal${closing ? " closing" : ""}`} ref={shell}>
      <Drawer
        className={`dialog-panel page-editor${dropActive ? " drop-active" : ""}`}
        labelledBy="dialog-panel-title"
        onClose={close}
        inert={closing}
        fileDropHandlers={
          acceptsFiles && !closing
            ? {
                onDragEnterCapture(event) {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  dragDepth.current += 1;
                  setDropActive(true);
                },
                onDragOverCapture(event) {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "copy";
                },
                onDragLeaveCapture(event) {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.stopPropagation();
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (!dragDepth.current) setDropActive(false);
                },
                onDropCapture(event) {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  dragDepth.current = 0;
                  setDropActive(false);
                  fileReceiver.current?.(Array.from(event.dataTransfer.files));
                },
              }
            : undefined
        }
      >
        {dropActive && <div className="page-drop-hint">Drop images or videos to attach</div>}
        <header className="dialog-header">
          <div>
            <p className="eyebrow">page details</p>
            <h2 id="dialog-panel-title">{ready ? "Edit page" : "Opening page editor"}</h2>
          </div>
          <div className="dialog-header-actions">
            <button
              aria-label="Copy link"
              className="icon-button"
              onClick={() => void copyLink()}
              type="button"
            >
              ⧉
            </button>
            <button
              aria-label={ready ? "Close page" : "Cancel opening"}
              className="icon-button"
              onClick={() => void close()}
              type="button"
            >
              ×
            </button>
          </div>
        </header>
        {/* Only a refusal has anything to say here; a success is the toast's to report. */}
        <Growing className="page-link-slot">
          {fallbackLink && (
            <div className="page-link" role="status">
              <p className="field-label">The clipboard was refused - copy the link by hand</p>
              <code className="page-link-value">{fallbackLink}</code>
            </div>
          )}
        </Growing>
        <PageDialog
          {...props}
          onOpenPage={(id) => void openPage(id)}
          registerCloseGuard={registerCloseGuard}
          registerFileReceiver={registerFileReceiver}
        />
      </Drawer>
    </div>
  );
}
