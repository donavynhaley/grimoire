import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePageMotion } from "../hooks/use-page-motion";
import { agentHandoffText } from "../lib/agent-handoff";
import { deferComponent } from "./Deferred";
import { Drawer } from "./Drawer";
import { Growing } from "./Growing";

type EditorProps = ComponentProps<typeof import("./PageDialog")["PageDialog"]>;
type Props = Omit<EditorProps, "registerCloseGuard" | "registerFileReceiver"> & {
  onClose: () => void;
  /** Named in the handoff block, so the agent knows which board the page belongs to. */
  projectId: string;
  projectName: string;
};

const PageDialog = deferComponent<EditorProps>(
  () => import("./PageDialog").then((module) => ({ default: module.PageDialog })),
  { exportName: "PageDialog", label: "page editor", dialogBody: true },
);

/** Keep one modal alive across the feature download, editing, and its saved exit. */
export function PageDialogShell({ onClose, projectId, projectName, ...props }: Props) {
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
  /* "" while nothing has been copied; the block itself once the clipboard refused it. */
  const [handoff, setHandoff] = useState("");
  const [copied, setCopied] = useState(false);
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
   * Hands the page to an agent, and does nothing else.
   *
   * A person copying is a person delegating: nothing starts, nothing is assigned and nothing
   * is recorded, so this never reaches the server. When the clipboard is refused - an
   * insecure origin, a permission denied - the block is shown instead of an error, because
   * selecting it by hand still works and that is the same answer the agent token's own copy
   * gives.
   */
  const copyForAgent = async () => {
    const text = agentHandoffText({
      origin: window.location.origin,
      pageId: props.page.id,
      projectId,
      projectName,
      title: props.page.title,
    });
    try {
      await navigator.clipboard.writeText(text);
      setHandoff("");
      setCopied(true);
    } catch {
      setCopied(false);
      setHandoff(text);
    }
  };

  // The confirmation is a receipt, not a state: it says the copy happened and then gets out
  // of the header's way.
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(timeout);
  }, [copied]);

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
              aria-label="Copy for agent"
              className="icon-button"
              onClick={() => void copyForAgent()}
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
        {/* One act, one status voice: the confirmation and the fallback are the same line. */}
        <Growing className="agent-handoff-slot">
          {copied && (
            <p className="agent-handoff-copied" role="status">
              Copied for agent
            </p>
          )}
          {handoff && (
            <div className="agent-handoff" role="status">
              <p className="field-label">The clipboard was refused - copy this by hand</p>
              <code className="agent-handoff-value">{handoff}</code>
            </div>
          )}
        </Growing>
        <PageDialog
          {...props}
          registerCloseGuard={registerCloseGuard}
          registerFileReceiver={registerFileReceiver}
        />
      </Drawer>
    </div>
  );
}
