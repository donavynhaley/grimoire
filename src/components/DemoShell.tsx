import { useEffect, useState } from "react";
import { App } from "../App";
import { setActiveProjectId } from "../api/client";
import { demoStorageNotice } from "../demo/mode";
import { browserDemoStore } from "../demo/store";
import { ConfirmInline } from "./ConfirmInline";
import { Growing } from "./Growing";

/** The demo's boundary stays visible while the ordinary application runs against local storage. */
export default function DemoShell() {
  const [generation, setGeneration] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState(demoStorageNotice);
  useEffect(() => {
    const update = () => setNotice(demoStorageNotice());
    window.addEventListener("grimoire-demo-storage", update);
    update();
    return () => window.removeEventListener("grimoire-demo-storage", update);
  }, []);
  const reset = () => {
    browserDemoStore().reset();
    history.replaceState({}, "", "/demo");
    setActiveProjectId(null);
    setConfirmReset(false);
    setGeneration((value) => value + 1);
  };
  return (
    <div className="demo-shell">
      <Growing className="demo-banner">
        <div className="demo-banner-row">
          <p>
            <strong>Your playground.</strong> Changes stay in this tab.
          </p>
          <div className="demo-actions">
            <ConfirmInline
              open={confirmReset}
              onOpen={() => setConfirmReset(true)}
              onCancel={() => setConfirmReset(false)}
              onConfirm={reset}
              trigger="Reset demo"
              triggerClass="quiet-button"
              question="Discard demo changes?"
              confirmLabel="Reset"
              cancelLabel="Keep playing"
            />
            <a href="/">Back to sign in</a>
          </div>
        </div>
        {notice && (
          <p className="demo-storage-notice" role="status">
            {notice}
          </p>
        )}
      </Growing>
      <div className="demo-workspace">
        <App key={generation} />
      </div>
    </div>
  );
}
