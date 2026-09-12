import { type ComponentProps, useCallback, useLayoutEffect, useRef, useState } from "react";
import { deferComponent } from "./Deferred";
import { Drawer } from "./Drawer";

type EditorProps = ComponentProps<typeof import("./PageDialog")["PageDialog"]>;
type Props = Omit<EditorProps, "registerCloseGuard"> & { onClose: () => void };

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

  useLayoutEffect(() => {
    if (!closing) return;
    let cancelled = false;
    // CSS owns the duration. Reduced motion has no animation and adds no exit delay.
    const exits =
      shell.current
        ?.getAnimations?.({ subtree: true })
        .filter(
          (animation) => "animationName" in animation && animation.animationName === "page-modal-fade-out",
        ) ?? [];
    const finish = () => {
      if (!cancelled) onCloseRef.current();
    };
    if (exits.length) void Promise.allSettled(exits.map((animation) => animation.finished)).then(finish);
    else finish();
    return () => {
      cancelled = true;
    };
  }, [closing]);

  return (
    <div className={`page-modal${closing ? " closing" : ""}`} ref={shell}>
      <Drawer
        className="dialog-panel page-editor"
        labelledBy="dialog-panel-title"
        onClose={close}
        inert={closing}
      >
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
        <PageDialog {...props} registerCloseGuard={registerCloseGuard} />
      </Drawer>
    </div>
  );
}
