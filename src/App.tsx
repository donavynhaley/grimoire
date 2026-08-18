import { useCallback, useEffect, useState } from "react";
import type { AwayState, BoardWorkspace, FieldType, PageStatus, IdeaState, IdeaWorkspace, SessionState, User, UserRole } from "../shared/types";
import { activity as loadActivity, ApiError, away as loadAway, board as loadBoard, editConflict, ideas as loadIdeas, liveEventsUrl, markSeen, mutate, request, session, setActiveProjectId, uploadAvatar } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { Board } from "./components/Board";
import type { CapturePageInput } from "./components/QuickCapture";
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
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  const [undoNotice, setUndoNotice] = useState<PendingUndo | null>(null);
  const [awayState, setAwayState] = useState<AwayState | null>(null);
  const dismissUndo = useCallback(() => setUndoNotice(null), []);

  /**
   * Marks everything current as seen, but only while the tab is actually on screen.
   * A board reloading behind a hidden tab stays unseen so it can greet the reader
   * on their next visit instead of silently slipping past them.
   */
  const advanceSeen = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    markSeen().catch(() => {
      // A missed advance only means the same changes greet the reader again.
    });
  }, []);

  // Bumped on every canonical reload so open history views know to refetch.
  const [revision, setRevision] = useState(0);

  const refreshBoard = useCallback(async () => {
    const value = await loadBoard();
    setActiveProjectId(value.project.id);
    setBoard(value);
    setRevision((current) => current + 1);
    setSessionState({ status: "authenticated", user: value.currentUser });
  }, []);

  const refreshIdeas = useCallback(async () => {
    setIdeas(await loadIdeas());
    setRevision((current) => current + 1);
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

  // The away boundary is captured once per project session: what the digest and
  // markers show stays stable for the whole visit even as the cursor advances.
  useEffect(() => {
    if (sessionState?.status !== "authenticated" || !board) return;
    let alive = true;
    setAwayState(null);
    loadAway()
      .then((value) => {
        if (!alive) return;
        setAwayState(value);
        advanceSeen();
      })
      .catch(() => {
        // The board works without its welcome-back decoration.
      });
    return () => { alive = false; };
  }, [advanceSeen, board?.project.id, sessionState?.status]);

  useEffect(() => {
    if (sessionState?.status !== "authenticated") return;
    const onVisibilityChange = () => advanceSeen();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [advanceSeen, sessionState?.status]);

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
          // Watching a live change happen counts as seeing it; hidden tabs skip this.
          advanceSeen();
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
    const receivePresence = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { online?: unknown };
        if (Array.isArray(payload.online)) setOnline(new Set(payload.online.map(String)));
      } catch {
        // Ignore malformed stream messages and keep the connection alive.
      }
    };

    source.addEventListener("workspace", receiveWorkspaceChange);
    source.addEventListener("presence", receivePresence);
    return () => {
      source.removeEventListener("workspace", receiveWorkspaceChange);
      source.removeEventListener("presence", receivePresence);
      source.close();
      setOnline(new Set());
    };
  }, [advanceSeen, board?.project.id, ideas !== null, refreshBoard, refreshIdeas, sessionState?.status]);

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

  /**
   * Like `perform`, minus the global banner.
   *
   * Settings mutations run inside a dialog that has its own outcome strip, and a refusal
   * printed there and on the banner behind the backdrop is the same message said twice.
   * The rethrow is the dialog's to answer.
   */
  const performSettings = async (change: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await change();
      await refreshBoard();
    } finally {
      setBusy(false);
    }
  };

  const createPage = (input: CapturePageInput) =>
    perform(() => mutate("/api/pages", "POST", input));

  /**
   * A refused save is the editor's business, not the banner's.
   *
   * The server rejects a write whose expected content no longer matches storage. That is
   * not a failure the reader can act on from a global error strip - it needs the record it
   * collided with, in the editor holding the text. So the canonical state is reloaded and
   * the refusal is rethrown for the dialog to answer.
   */
  const performEdit = async (change: () => Promise<unknown>, reload: () => Promise<void>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await change();
      await reload();
    } catch (value) {
      if (editConflict(value)) await reload().catch(() => undefined);
      else setError(value instanceof ApiError ? value.message : message);
      throw value;
    } finally {
      setBusy(false);
    }
  };

  const updatePage = async (id: string, input: Record<string, unknown>) => {
    const previous = board;
    if (previous) setBoard(applyOptimisticPageUpdate(previous, id, input));
    try {
      await performEdit(
        () => mutate(`/api/pages/${id}`, "PATCH", input),
        refreshBoard,
        "The change could not be saved",
      );
    } catch (error) {
      if (previous && !editConflict(error)) setBoard(previous);
      throw error;
    }
  };

  const archivePage = async (id: string) => {
    const title = board?.pages.find((page) => page.id === id)?.title ?? "page";
    await perform(() => mutate(`/api/pages/${id}`, "DELETE"));
    setUndoNotice({
      actionLabel: "Undo archive",
      id: Date.now(),
      message: `Archived ${title}`,
      run: () => perform(() => mutate(`/api/pages/${id}/restore`, "POST")),
    });
  };

  /** Brings an archived page back to its former column and place, long after the undo toast. */
  const restorePage = (id: string) => perform(() => mutate(`/api/pages/${id}/restore`, "POST"));

  const moveBacklogToNext = async (id: string) => {
    const page = board?.pages.find((candidate) => candidate.id === id);
    if (!page || !board) return;
    const previousPosition = page.position;
    const readyPosition = board.pages.filter((candidate) => candidate.status === "ready").length;
    await updatePage(id, { status: "ready", position: readyPosition });
    setUndoNotice({
      actionLabel: "Undo move to Up Next",
      id: Date.now(),
      message: `Moved ${page.title} to Up Next`,
      run: () => updatePage(id, { status: "backlog", position: previousPosition }),
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
  const updateIdea = (id: string, input: Record<string, unknown>) =>
    performEdit(() => mutate(`/api/ideas/${id}`, "PATCH", input), refreshIdeas, "The idea could not be saved");
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

  const removeMember = (id: string) => performSettings(() => mutate(`/api/members/${id}`, "DELETE"));

  const changeMemberRole = (id: string, role: UserRole) =>
    performSettings(() => mutate(`/api/members/${id}`, "PATCH", { role }));

  const changePassword = async (currentPassword: string, newPassword: string) => {
    await mutate("/api/account/password", "POST", { currentPassword, newPassword });
  };

  const changeName = async (name: string) => {
    const result = await mutate<{ user: User }>("/api/account/name", "POST", { name });
    setSessionState({ status: "authenticated", user: result.user });
    await refreshBoard();
    if (ideas) await refreshIdeas();
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
    performSettings(() => mutate(`/api/projects/${id}`, "PATCH", { name }));

  const describeProject = (id: string, description: string) =>
    performSettings(() => mutate(`/api/projects/${id}`, "PATCH", { description }));

  const archiveProject = async (id: string) => {
    const name = board?.projects.find((candidate) => candidate.id === id)?.name ?? "project";
    await mutate(`/api/projects/${id}`, "DELETE");
    await openProject(null);
    // Archiving a whole project gets the same eight seconds of grace a page does; after the
    // toast is gone, the Danger zone's archived list is the durable way back.
    setUndoNotice({
      actionLabel: "Undo archive",
      id: Date.now(),
      message: `Archived ${name}`,
      run: async () => {
        await mutate(`/api/projects/${id}/restore`, "POST");
        await openProject(id);
      },
    });
  };

  const restoreProject = (id: string) =>
    performSettings(() => mutate(`/api/projects/${id}/restore`, "POST"));

  const createCategory = (input: { name: string; color: string }) =>
    performSettings(() => mutate("/api/categories", "POST", input));
  const updateCategory = (slug: string, input: { name?: string; color?: string; position?: number }) =>
    performSettings(() => mutate(`/api/categories/${slug}`, "PATCH", input));
  const deleteCategory = (slug: string) => performSettings(() => mutate(`/api/categories/${slug}`, "DELETE"));

  const createField = (input: { label: string; type: FieldType; options?: string[]; showOnTile?: boolean }) =>
    performSettings(() => mutate("/api/fields", "POST", input));
  const updateField = (key: string, input: { label?: string; options?: string[]; showOnTile?: boolean; position?: number }) =>
    performSettings(() => mutate(`/api/fields/${key}`, "PATCH", input));
  const deleteField = (key: string) => performSettings(() => mutate(`/api/fields/${key}`, "DELETE"));

  const createChapter = (input: { name: string; startsOn?: string | null; endsOn?: string | null }) =>
    performSettings(() => mutate("/api/chapters", "POST", input));
  const updateChapter = (slug: string, input: Record<string, unknown>) =>
    performSettings(() => mutate(`/api/chapters/${slug}`, "PATCH", input));
  const deleteChapter = (slug: string) => performSettings(() => mutate(`/api/chapters/${slug}`, "DELETE"));
  const setChaptersEnabled = (enabled: boolean) =>
    performSettings(() => mutate(`/api/projects/${board?.project.id}`, "PATCH", { chaptersEnabled: enabled }));

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
        away={awayState}
        board={board}
        busy={busy}
        categoryActions={{ create: createCategory, update: updateCategory, remove: deleteCategory }}
        fieldActions={{ create: createField, update: updateField, remove: deleteField }}
        chapterActions={{ create: createChapter, update: updateChapter, remove: deleteChapter }}
        ideas={ideas}
        key={board.project.id}
        onChangeAvatar={changeAvatar}
        onChangeName={changeName}
        onChangePassword={changePassword}
        onRemoveAvatar={removeAvatar}
        onArchive={archivePage}
        onCreate={createPage}
        onCreateInvite={createInvite}
        onCreateIdea={createIdea}
        online={online}
        onLoadActivity={loadActivity}
        onLogout={logout}
        onMoveBacklogToNext={moveBacklogToNext}
        revision={revision}
        onPromoteIdea={promoteIdea}
        onChangeMemberRole={changeMemberRole}
        onRemoveMember={removeMember}
        onRestorePage={restorePage}
        onSurfaceError={setError}
        onUpdate={updatePage}
        onUpdateIdea={updateIdea}
        onViewChange={changeView}
        projectActions={{ select: selectProject, create: createProject, rename: renameProject, archive: archiveProject }}
        projectSettingsActions={{
          rename: (name) => renameProject(board.project.id, name),
          setDescription: (description) => describeProject(board.project.id, description),
          setChaptersEnabled,
          setGithubRepo: (repo) => performSettings(() => mutate(`/api/projects/${board.project.id}`, "PATCH", { githubRepo: repo })),
          setGithubToken: (token) => performSettings(() => mutate(`/api/projects/${board.project.id}`, "PATCH", { githubToken: token })),
          archive: () => archiveProject(board.project.id),
          restore: restoreProject,
        }}
        view={view}
      />
    </>
  );
}

function applyOptimisticPageUpdate(
  board: BoardWorkspace,
  id: string,
  input: Record<string, unknown>,
): BoardWorkspace {
  const current = board.pages.find((page) => page.id === id);
  if (!current) return board;
  // The github reference travels as pasted text and only the server can read it into a
  // link, so the optimistic page keeps what it had until the parsed truth arrives.
  const { github: _github, ...safeInput } = input;
  input = safeInput;
  const targetStatus = (input.status as PageStatus | undefined) ?? current.status;
  const targetPosition = typeof input.position === "number" ? input.position : current.position;
  const completedAt = targetStatus === "done"
    ? current.status === "done" ? current.completedAt : new Date().toISOString()
    : null;
  const assigneeId = input.assigneeId === undefined ? current.assigneeId : (input.assigneeId as string | null);
  const assignee = board.members.find((member) => member.id === assigneeId);
  const remaining = board.pages.filter((page) => page.id !== id);
  const targetPages = remaining
    .filter((page) => page.status === targetStatus)
    .sort((a, b) => a.position - b.position);
  const insertAt = Math.max(0, Math.min(targetPosition, targetPages.length));
  targetPages.splice(insertAt, 0, {
    ...current,
    ...input,
    status: targetStatus,
    completedAt,
    assigneeId,
    assigneeName: assignee?.name ?? null,
  });
  const reordered = targetPages.map((page, position) => ({ ...page, position }));
  return {
    ...board,
    pages: [
      ...remaining.filter((page) => page.status !== targetStatus),
      ...reordered,
    ],
  };
}
