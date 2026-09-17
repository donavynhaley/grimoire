import { type ComponentProps, useCallback, useLayoutEffect, useRef, useState } from "react";
import { usePageMotion } from "../hooks/use-page-motion";
import { motionWasAsked, type PageMotion, resolvePageMotion } from "../lib/page-motion";
import { deferComponent } from "./Deferred";
import { Drawer } from "./Drawer";
import { MotionPicker } from "./MotionPicker";

type EditorProps = ComponentProps<typeof import("./PageDialog")["PageDialog"]>;
type Props = Omit<EditorProps, "registerCloseGuard" | "registerFileReceiver"> & { onClose: () => void };

const PageDialog = deferComponent<EditorProps>(
  () => import("./PageDialog").then((module) => ({ default: module.PageDialog })),
  { exportName: "PageDialog", label: "page editor", dialogBody: true },
);

/** Keep one modal alive across the feature download, editing, and its saved exit. */
export function PageDialogShell({ onClose, ...props }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [motion, setMotion] = useState<PageMotion>(() => resolvePageMotion(window.location.search));
  const comparing = motionWasAsked(window.location.search);
  const fileReceiver = useRef<((files: File[]) => void) | null>(null);
  const [acceptsFiles, setAcceptsFiles] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
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
    motion,
    originId: props.page.id,
    closing,
    onExited: useCallback(() => onCloseRef.current(), []),
  });

  return (
    <div className={`page-modal${closing ? " closing" : ""}`} data-motion={motion} ref={shell}>
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
          <button
            aria-label={ready ? "Close page" : "Cancel opening"}
            className="icon-button"
            onClick={() => void close()}
            type="button"
          >
            ×
          </button>
        </header>
        <PageDialog
          {...props}
          registerCloseGuard={registerCloseGuard}
          registerFileReceiver={registerFileReceiver}
        />
      </Drawer>
      {comparing && (
        <MotionPicker
          motion={motion}
          onChange={(chosen) => {
            setMotion(chosen);
            const address = new URL(window.location.href);
            address.searchParams.set("motion", chosen);
            window.history.replaceState(null, "", address);
          }}
        />
      )}
    </div>
  );
}
