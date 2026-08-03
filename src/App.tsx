import { useCallback, useEffect, useState } from "react";
import type { SessionState, User, Workspace } from "../shared/types";
import { ApiError, mutate, request, session, workspace as loadWorkspace } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { Shell, type ViewName } from "./components/Shell";
import { AssetsView } from "./views/AssetsView";
import { DirectionView } from "./views/DirectionView";
import { IdeasView } from "./views/IdeasView";
import { MyWorkView } from "./views/MyWorkView";
import { OutcomesView } from "./views/OutcomesView";
import { OverviewView } from "./views/OverviewView";
import { PlaytestsView } from "./views/PlaytestsView";
import { TeamView } from "./views/TeamView";

const views: ViewName[] = ["overview", "direction", "outcomes", "ideas", "assets", "playtests", "my work", "team"];

function viewFromHash(): ViewName {
  const value = decodeURIComponent(location.hash.replace(/^#/, ""));
  return views.includes(value as ViewName) ? (value as ViewName) : "overview";
}

export function App() {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeView, setActiveView] = useState<ViewName>(viewFromHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshWorkspace = useCallback(async () => {
    const value = await loadWorkspace();
    setWorkspace(value);
    setSessionState({ status: "authenticated", user: value.currentUser });
  }, []);

  useEffect(() => {
    let alive = true;
    session()
      .then(async (value) => {
        if (!alive) return;
        setSessionState(value);
        if (value.status === "authenticated") {
          const data = await loadWorkspace();
          if (alive) setWorkspace(data);
        }
      })
      .catch((value) => alive && setError(value instanceof Error ? value.message : "Could not reach Grimoire"));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onHash = () => setActiveView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (view: ViewName) => {
    setActiveView(view);
    history.replaceState(null, "", `#${encodeURIComponent(view)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onAuthenticated = async (_user: User) => {
    await refreshWorkspace();
  };

  const runMutation = async (path: string, method: "POST" | "PATCH", body: unknown = {}) => {
    setBusy(true);
    setError("");
    try {
      await mutate(path, method, body);
      await refreshWorkspace();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "The change could not be saved");
      throw value;
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    setWorkspace(null);
    setSessionState({ status: "anonymous" });
  };

  if (error && !sessionState) {
    return <div className="loading-screen"><span className="brand-mark">g</span><p>{error}</p><button className="secondary-button" onClick={() => location.reload()} type="button">retry</button></div>;
  }
  if (!sessionState || (sessionState.status === "authenticated" && !workspace)) {
    return <div className="loading-screen"><span className="brand-mark pulse">g</span><p>opening grimoire...</p></div>;
  }
  if (sessionState.status === "setup_required") {
    return <AuthScreen mode="setup" onAuthenticated={onAuthenticated} />;
  }
  if (sessionState.status === "anonymous") {
    const invite = new URLSearchParams(location.search).get("invite") ?? undefined;
    return <AuthScreen inviteCode={invite} mode={invite ? "register" : "login"} onAuthenticated={onAuthenticated} />;
  }
  if (!workspace) return null;

  const props = { workspace, runMutation, navigate, busy };
  const content =
    activeView === "direction" ? <DirectionView {...props} />
      : activeView === "outcomes" ? <OutcomesView {...props} />
        : activeView === "ideas" ? <IdeasView {...props} />
          : activeView === "assets" ? <AssetsView {...props} />
            : activeView === "playtests" ? <PlaytestsView {...props} />
              : activeView === "my work" ? <MyWorkView {...props} />
                : activeView === "team" ? <TeamView {...props} />
                  : <OverviewView {...props} />;

  return (
    <Shell workspace={workspace} activeView={activeView} onNavigate={navigate} onLogout={logout}>
      {error && <div className="error-banner global-error" role="alert">{error}</div>}
      {content}
      {busy && <div className="saving-indicator"><span className="connection-dot" />saving</div>}
    </Shell>
  );
}

