import { useCallback, useEffect, useState } from "react";
import type { BoardWorkspace, CardStatus, IdeaState, IdeaWorkspace, SessionState, User } from "../shared/types";
import { ApiError, board as loadBoard, ideas as loadIdeas, mutate, request, session } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { Board } from "./components/Board";

export function App() {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [board, setBoard] = useState<BoardWorkspace | null>(null);
  const [ideas, setIdeas] = useState<IdeaWorkspace | null>(null);
  const [view, setView] = useState<"work" | "ideas">(
    new URLSearchParams(location.search).get("view") === "ideas" ? "ideas" : "work",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshBoard = useCallback(async () => {
    const value = await loadBoard();
    setBoard(value);
    setSessionState({ status: "authenticated", user: value.currentUser });
  }, []);

  useEffect(() => {
    let alive = true;
    session()
      .then(async (value) => {
        if (!alive) return;
        setSessionState(value);
        if (value.status === "authenticated") {
          const [boardData, ideaData] = await Promise.all([
            loadBoard(),
            view === "ideas" ? loadIdeas() : Promise.resolve(null),
          ]);
          if (alive) {
            setBoard(boardData);
            setIdeas(ideaData);
          }
        }
      })
      .catch((value) => alive && setError(value instanceof Error ? value.message : "Could not reach Grimoire"));
    return () => { alive = false; };
  }, []);

  const onAuthenticated = async (_user: User) => {
    await refreshBoard();
  };

  const perform = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await change();
      await refreshBoard();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "The change could not be saved");
      throw value;
    } finally {
      setBusy(false);
    }
  };

  const createCard = (input: { title: string; status: CardStatus }) =>
    perform(() => mutate("/api/cards", "POST", input));

  const updateCard = async (id: string, input: Record<string, unknown>) => {
    const previous = board;
    if (previous) setBoard(applyOptimisticCardUpdate(previous, id, input));
    try {
      await perform(() => mutate(`/api/cards/${id}`, "PATCH", input));
    } catch (error) {
      if (previous) setBoard(previous);
      throw error;
    }
  };

  const archiveCard = (id: string) => perform(() => mutate(`/api/cards/${id}`, "DELETE"));

  const changeView = async (nextView: "work" | "ideas") => {
    setView(nextView);
    const params = new URLSearchParams(location.search);
    if (nextView === "ideas") params.set("view", "ideas");
    else params.delete("view");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    if (nextView === "ideas" && !ideas) {
      try {
        setIdeas(await loadIdeas());
      } catch (value) {
        setError(value instanceof ApiError ? value.message : "The idea garden could not be opened");
      }
    }
  };

  const performIdea = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await change();
      setIdeas(await loadIdeas());
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "The idea could not be saved");
      throw value;
    } finally {
      setBusy(false);
    }
  };

  const createIdea = (input: { title: string }) => performIdea(() => mutate("/api/ideas", "POST", input));
  const updateIdea = (id: string, input: { title?: string; description?: string; state?: IdeaState; position?: number }) =>
    performIdea(() => mutate(`/api/ideas/${id}`, "PATCH", input));
  const promoteIdea = async (id: string) => {
    await performIdea(() => mutate(`/api/ideas/${id}/promote`, "POST"));
    await refreshBoard();
  };

  const createInvite = async () => {
    const result = await mutate<{ code: string }>("/api/invites", "POST");
    return `${location.origin}${location.pathname}?invite=${encodeURIComponent(result.code)}`;
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    await mutate("/api/account/password", "POST", { currentPassword, newPassword });
  };

  const logout = async () => {
    await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    setBoard(null);
    setIdeas(null);
    setSessionState({ status: "anonymous" });
  };

  if (error && !sessionState) {
    return <div className="loading-screen"><span className="brand-mark">g</span><p>{error}</p><button className="quiet-button" onClick={() => location.reload()} type="button">retry</button></div>;
  }
  if (!sessionState || (sessionState.status === "authenticated" && !board)) {
    return <div className="loading-screen"><span className="brand-mark pulse">g</span><p>opening grimoire...</p></div>;
  }
  if (sessionState.status === "setup_required") {
    return <AuthScreen mode="setup" onAuthenticated={onAuthenticated} />;
  }
  if (sessionState.status === "anonymous") {
    const invite = new URLSearchParams(location.search).get("invite") ?? undefined;
    return <AuthScreen inviteCode={invite} mode={invite ? "register" : "login"} onAuthenticated={onAuthenticated} />;
  }
  if (!board) return null;

  return (
    <>
      {error && <div className="error-banner global-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")} type="button">×</button></div>}
      <Board
        board={board}
        busy={busy}
        ideas={ideas}
        onChangePassword={changePassword}
        onArchive={archiveCard}
        onCreate={createCard}
        onCreateInvite={createInvite}
        onCreateIdea={createIdea}
        onLogout={logout}
        onPromoteIdea={promoteIdea}
        onUpdate={updateCard}
        onUpdateIdea={updateIdea}
        onViewChange={changeView}
        view={view}
      />
    </>
  );
}

function applyOptimisticCardUpdate(
  board: BoardWorkspace,
  id: string,
  input: Record<string, unknown>,
): BoardWorkspace {
  const current = board.cards.find((card) => card.id === id);
  if (!current) return board;
  const targetStatus = (input.status as CardStatus | undefined) ?? current.status;
  const targetPosition = typeof input.position === "number" ? input.position : current.position;
  const assigneeId = input.assigneeId === undefined ? current.assigneeId : (input.assigneeId as string | null);
  const assignee = board.members.find((member) => member.id === assigneeId);
  const remaining = board.cards.filter((card) => card.id !== id);
  const targetCards = remaining
    .filter((card) => card.status === targetStatus)
    .sort((a, b) => a.position - b.position);
  const insertAt = Math.max(0, Math.min(targetPosition, targetCards.length));
  targetCards.splice(insertAt, 0, {
    ...current,
    ...input,
    status: targetStatus,
    assigneeId,
    assigneeName: assignee?.name ?? null,
  });
  const reordered = targetCards.map((card, position) => ({ ...card, position }));
  return {
    ...board,
    cards: [
      ...remaining.filter((card) => card.status !== targetStatus),
      ...reordered,
    ],
  };
}
