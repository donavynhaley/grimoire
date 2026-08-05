import { useCallback, useEffect, useState } from "react";
import type { BoardWorkspace, CardStatus, IdeaState, IdeaWorkspace, SessionState, User } from "../shared/types";
import { ApiError, board as loadBoard, ideas as loadIdeas, liveEventsUrl, mutate, request, session, setActiveProjectId, uploadAvatar } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { Board } from "./components/Board";
import type { CaptureCardInput } from "./components/QuickCapture";
import { type UndoNotice, UndoToast } from "./components/UndoToast";

type PendingUndo = UndoNotice & {
  run: () => Promise<void>;
};

export function App() {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [board, setBoard] = useState<BoardWorkspace | null>(null);
  const [ideas, setIdeas] = useState<IdeaWorkspace | null>(null);
  const [view, setView] = useState<"work" | "ideas">(
    new URLSearchParams(location.search).get("view") === "ideas" ? "ideas" : "work",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undoNotice, setUndoNotice] = useState<PendingUndo | null>(null);
  const dismissUndo = useCallback(() => setUndoNotice(null), []);

  const refreshBoard = useCallback(async () => {
    const value = await loadBoard();
    setActiveProjectId(value.project.id);
    setBoard(value);
    setSessionState({ status: "authenticated", user: value.currentUser });
  }, []);

  const refreshIdeas = useCallback(async () => {
    setIdeas(await loadIdeas());
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

  useEffect(() => {
    if (sessionState?.status !== "authenticated" || !board || typeof EventSource === "undefined") return;
    const source = new EventSource(liveEventsUrl());
    let pendingWork = false;
    let pendingIdeas = false;
    let refreshing = false;

    const flush = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        while (pendingWork || pendingIdeas) {
          const work = pendingWork;
          const ideaGarden = pendingIdeas;
          pendingWork = false;
          pendingIdeas = false;
          await Promise.all([
            work ? refreshBoard() : Promise.resolve(),
            ideaGarden && ideas !== null ? refreshIdeas() : Promise.resolve(),
          ]);
        }
      } catch (value) {
        setError(value instanceof ApiError ? value.message : "Live changes could not be loaded");
      } finally {
        refreshing = false;
      }
    };

    const receiveWorkspaceChange = (event: Event) => {
      try {
        const scope = JSON.parse((event as MessageEvent<string>).data) as { scope?: string };
        pendingWork ||= scope.scope === "work" || scope.scope === "both";
        pendingIdeas ||= scope.scope === "ideas" || scope.scope === "both";
        void flush();
      } catch {
        // Ignore malformed stream messages and keep the connection alive.
      }
    };
    source.addEventListener("workspace", receiveWorkspaceChange);
    return () => {
      source.removeEventListener("workspace", receiveWorkspaceChange);
      source.close();
    };
  }, [board?.project.id, ideas !== null, refreshBoard, refreshIdeas, sessionState?.status]);

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

  const createCard = (input: CaptureCardInput) =>
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

  const archiveCard = async (id: string) => {
    const title = board?.cards.find((card) => card.id === id)?.title ?? "card";
    await perform(() => mutate(`/api/cards/${id}`, "DELETE"));
    setUndoNotice({
      actionLabel: "Undo archive",
      id: Date.now(),
      message: `Archived ${title}`,
      run: () => perform(() => mutate(`/api/cards/${id}/restore`, "POST")),
    });
  };

  const moveBacklogToNext = async (id: string) => {
    const card = board?.cards.find((candidate) => candidate.id === id);
    if (!card || !board) return;
    const previousPosition = card.position;
    const readyPosition = board.cards.filter((candidate) => candidate.status === "ready").length;
    await updateCard(id, { status: "ready", position: readyPosition });
    setUndoNotice({
      actionLabel: "Undo move to Up Next",
      id: Date.now(),
      message: `Moved ${card.title} to Up Next`,
      run: () => updateCard(id, { status: "backlog", position: previousPosition }),
    });
  };

  const changeView = async (nextView: "work" | "ideas") => {
    setView(nextView);
    const params = new URLSearchParams(location.search);
    if (nextView === "ideas") params.set("view", "ideas");
    else params.delete("view");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    if (nextView === "ideas" && !ideas) {
      try {
        await refreshIdeas();
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
      await refreshIdeas();
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
    const title = ideas?.ideas.find((idea) => idea.id === id)?.title ?? "idea";
    await performIdea(() => mutate(`/api/ideas/${id}/promote`, "POST"));
    await refreshBoard();
    setUndoNotice({
      actionLabel: "Undo promotion",
      id: Date.now(),
      message: `Promoted ${title}`,
      run: async () => {
        setBusy(true);
        setError("");
        try {
          await mutate(`/api/ideas/${id}/promotion`, "DELETE");
          await Promise.all([refreshBoard(), refreshIdeas()]);
        } catch (value) {
          setError(value instanceof ApiError ? value.message : "The promotion could not be undone");
          throw value;
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const undoLastChange = async () => {
    const notice = undoNotice;
    if (!notice) return;
    setUndoNotice(null);
    try {
      await notice.run();
    } catch {
      // The operation already surfaced its error in the global banner.
    }
  };

  const createInvite = async () => {
    const result = await mutate<{ code: string }>("/api/invites", "POST");
    return `${location.origin}${location.pathname}?invite=${encodeURIComponent(result.code)}`;
  };

  const removeMember = (id: string) => perform(() => mutate(`/api/members/${id}`, "DELETE"));

  const changePassword = async (currentPassword: string, newPassword: string) => {
    await mutate("/api/account/password", "POST", { currentPassword, newPassword });
  };

  const changeAvatar = (file: File) => perform(() => uploadAvatar(file));
  const removeAvatar = () => perform(() => mutate("/api/account/avatar", "DELETE"));

  const syncProjectUrl = (id: string | null) => {
    const params = new URLSearchParams(location.search);
    if (id) params.set("project", id);
    else params.delete("project");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const openProject = async (id: string | null) => {
    setUndoNotice(null);
    setActiveProjectId(id);
    syncProjectUrl(id);
    setIdeas(null);
    setBusy(true);
    setError("");
    try {
      await refreshBoard();
      if (view === "ideas") await refreshIdeas();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : "The project could not be opened");
      throw value;
    } finally {
      setBusy(false);
    }
  };

  const selectProject = async (id: string) => {
    if (id === board?.project.id) return;
    await openProject(id);
  };

  const createProject = async (name: string) => {
    const result = await mutate<{ project: { id: string } }>("/api/projects", "POST", { name });
    await openProject(result.project.id);
  };

  const renameProject = (id: string, name: string) =>
    perform(() => mutate(`/api/projects/${id}`, "PATCH", { name }));

  const archiveProject = async (id: string) => {
    await mutate(`/api/projects/${id}`, "DELETE");
    await openProject(null);
  };

  const createCategory = (input: { name: string; color: string }) =>
    perform(() => mutate("/api/categories", "POST", input));
  const updateCategory = (slug: string, input: { name?: string; color?: string }) =>
    perform(() => mutate(`/api/categories/${slug}`, "PATCH", input));
  const deleteCategory = (slug: string) => perform(() => mutate(`/api/categories/${slug}`, "DELETE"));

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
      {undoNotice && <UndoToast notice={undoNotice} onDismiss={dismissUndo} onUndo={() => void undoLastChange()} />}
      <Board
        board={board}
        busy={busy}
        categoryActions={{ create: createCategory, update: updateCategory, remove: deleteCategory }}
        ideas={ideas}
        key={board.project.id}
        onChangeAvatar={changeAvatar}
        onChangePassword={changePassword}
        onRemoveAvatar={removeAvatar}
        onArchive={archiveCard}
        onCreate={createCard}
        onCreateInvite={createInvite}
        onCreateIdea={createIdea}
        onLogout={logout}
        onMoveBacklogToNext={moveBacklogToNext}
        onPromoteIdea={promoteIdea}
        onRemoveMember={removeMember}
        onUpdate={updateCard}
        onUpdateIdea={updateIdea}
        onViewChange={changeView}
        projectActions={{ select: selectProject, create: createProject, rename: renameProject, archive: archiveProject }}
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
  const completedAt = targetStatus === "done"
    ? current.status === "done" ? current.completedAt : new Date().toISOString()
    : null;
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
    completedAt,
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
