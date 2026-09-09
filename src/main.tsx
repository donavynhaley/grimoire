import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { demoMode } from "./demo/mode";

const DemoShell = lazy(() => import("./components/DemoShell"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="loading-screen">Opening your playground...</div>}>
      {demoMode ? <DemoShell /> : <App />}
    </Suspense>
  </StrictMode>,
);
