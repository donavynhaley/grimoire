import { type ComponentType, useEffect, useRef, useState } from "react";
import { useSlowWait } from "../hooks/use-slow-wait";
import { Drawer } from "./Drawer";

type Options<P> = {
  exportName: string;
  label: string;
  close?: (props: P) => () => void;
  workspace?: boolean;
};

/** Cache successful feature imports; failures stay local and retry without replacing the board. */
export function deferComponent<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
  options: Options<P>,
): ComponentType<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<void> | undefined;
  let retryUrl: URL | undefined;
  let retryNumber = 0;
  const load = () => {
    const request = () => {
      if (!retryUrl) return loader();
      // Chromium caches a failed native import. A fresh URL retries only this feature;
      // its dependencies are already loaded by the board (enforced by check:bundle).
      retryUrl.searchParams.set("retry", String(++retryNumber));
      return import(/* @vite-ignore */ retryUrl.href).then((module) => ({
        default: module[options.exportName] as ComponentType<P>,
      }));
    };
    pending ??= request()
      .then((module) => {
        if (!module.default) throw new Error("The feature could not be loaded");
        loaded = module.default;
      })
      .catch((error: unknown) => {
        pending = undefined;
        // Only retry our own same-origin production feature, never an arbitrary error URL.
        const address = error instanceof Error ? error.message.match(/https?:\/\/[^\s]+/)?.[0] : undefined;
        if (address) {
          const url = new URL(address);
          if (
            url.origin === window.location.origin &&
            url.pathname.startsWith(`/assets/${options.exportName}-`) &&
            url.pathname.endsWith(".js")
          )
            retryUrl = url;
        }
        throw error;
      });
    return pending;
  };
  return function DeferredComponent(props: P) {
    const [component, setComponent] = useState(() => loaded);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const slow = useSlowWait(!component);
    const inline = useRef<HTMLDivElement>(null);
    const focusAfterLoad = useRef(false);
    useEffect(() => {
      if (component && focusAfterLoad.current) {
        inline.current?.querySelector<HTMLElement>('[role="textbox"], input, button')?.focus();
        focusAfterLoad.current = false;
      }
    }, [component]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt repeats a failed import; loader and loaded belong to this module-scoped feature definition
    useEffect(() => {
      if (loaded) {
        setComponent(() => loaded);
        return;
      }
      let alive = true;
      load()
        .then(() => {
          if (alive) {
            focusAfterLoad.current = inline.current?.contains(document.activeElement) ?? false;
            setComponent(() => loaded);
          }
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
      return () => {
        alive = false;
      };
    }, [attempt]);
    if (component) {
      const Feature = component;
      return options.close || options.workspace ? (
        <Feature {...props} />
      ) : (
        <div ref={inline} style={{ display: "contents" }}>
          <Feature {...props} />
        </div>
      );
    }
    const notice = failed ? (
      <div role="alert">
        <p>Could not load {options.label}. Your open work is still here.</p>
        <button
          className="quiet-button"
          type="button"
          onClick={() => {
            if (options.workspace) {
              // The workspace has not mounted yet, so there are no editor drafts to lose.
              window.location.reload();
              return;
            }
            inline.current?.focus();
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          Retry loading
        </button>
      </div>
    ) : slow ? (
      <p role="status">Opening {options.label}...</p>
    ) : null;
    const close = options.close?.(props);
    if (close)
      return (
        <Drawer className="dialog-panel deferred-dialog" label={`Opening ${options.label}`} onClose={close}>
          <header className="dialog-header">
            <h2>Opening {options.label}</h2>
            <button type="button" className="icon-button" aria-label="Cancel opening" onClick={close}>
              ×
            </button>
          </header>
          {notice}
        </Drawer>
      );
    return (
      <div ref={inline} tabIndex={-1} className={options.workspace ? "loading-screen" : "deferred-inline"}>
        {notice}
      </div>
    );
  };
}
