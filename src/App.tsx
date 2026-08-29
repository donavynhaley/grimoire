import { useCallback, useEffect, useState } from "react";
import type {
  BoardWorkspace,
  FieldType,
  IdeaWorkspace,
  ProjectRole,
  SessionState,
  User,
} from "../shared/types";
import {
  ApiError,
  editConflict,
  activity as loadActivity,
  board as loadBoard,
  discussion as loadDiscussion,
  ideas as loadIdeas,
  markDiscussionSeen,
  mutate,
  openThread,
  replyToThread,
  request,
  session,
  setActiveProjectId,
  setThreadAnswered,
  uploadAvatar,
} from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { Board } from "./components/Board";
import type { CapturePageInput } from "./components/QuickCapture";
import { type UndoNotice, UndoToast } from "./components/UndoToast";
import { useAwayState } from "./hooks/use-away-state";
import { useLiveEvents } from "./hooks/use-live-events";
import { useSlowWait } from "./hooks/use-slow-wait";
import { applyOptimisticPageUpdate } from "./lib/optimistic-page";

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
  const [projectOpening, setProjectOpening] = useState(false);
  const projectOpeningSlow = useSlowWait(projectOpening);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undoNotice, setUndoNotice] = useState<PendingUndo | null>(null);
  const dismissUndo = useCallback(() => setUndoNotice(null), []);
  const authenticated = sessionState?.status === "authenticated";
  const { awayState, advanceSeen } = useAwayState(authenticated, board?.project.id);

  // Bumped on every canonical reload so open history views know to refetch.
  const [revision, setRevision] = useState(0);

  /** Everything committing a freshly read workspace means, so a caller can read first. */
  const applyBoard = useCallback((value: BoardWorkspace) => {
    setActiveProjectId(value.project.id);
    setBoard(value);
    setRevision((current) => current + 1);
    setSessionState({ status: "authenticated", user: value.currentUser });
  }, []);

  const refreshBoard = useCallback(async () => {
    applyBoard(await loadBoard());
  }, [applyBoard]);

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
      .catch(
        (value) => alive && setError(value instanceof Error ? value.message : "Could not reach Grimoire"),
      );
    return () => {
      alive = false;
    };
  }, []);

  const online = useLiveEvents({
    active: authenticated && board !== null,
    projectId: board?.project.id,
    ideasLoaded: ideas !== null,
    refreshBoard,
    refreshIdeas,
    advanceSeen,
    onError: setError,
  });

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

  const createPage = (input: CapturePageInput) => perform(() => mutate("/api/pages", "POST", input));

  /**
   * A refused save is the editor's business, not the banner's.
   *
   * The server rejects a write whose expected content no longer matches storage. That is
   * not a failure the reader can act on from a global error strip - it needs the record it
   * collided with, in the editor holding the text. So the canonical state is reloaded and
   * the refusal is rethrown for the dialog to answer.
   */
  const performEdit = async (
    change: () => Promise<unknown>,
    reload: () => Promise<void>,
    message: string,
  ) => {
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

  /*
   * Saying something changes the board as well as the page: the tile carries how many threads
   * are still open, so every one of these goes through `perform` and refreshes it. The dialog
   * reloads its own threads on top of that, because the board carries the count and not the
   * conversation.
   */
  const askOnPage = (pageId: string, body: string) =>
    perform(() => openThread(pageId, body)).then(() => undefined);
  const replyOnPage = (pageId: string, threadId: string, body: string) =>
    perform(() => replyToThread(pageId, threadId, body)).then(() => undefined);
  const answerOnPage = (pageId: string, threadId: string, answered: boolean) =>
    perform(() => setThreadAnswered(pageId, threadId, answered)).then(() => undefined);
  /*
   * Reading is not a change anyone else can see, so it does not go through `perform` and its
   * error banner - a failed read marker is worth nothing to report. The board is refreshed
   * anyway, because the count on the control is carried on the page.
   */
  const seeDiscussion = async (pageId: string) => {
    try {
      await markDiscussionSeen(pageId);
      await refreshBoard();
    } catch {
      // The count stays where it was until the next visit, which is the harmless failure.
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
    performEdit(
      () => mutate(`/api/ideas/${id}`, "PATCH", input),
      refreshIdeas,
      "The idea could not be saved",
    );
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

  const addMember = (email: string) => performSettings(() => mutate("/api/members", "POST", { email }));

  const removeMember = (id: string) => performSettings(() => mutate(`/api/members/${id}`, "DELETE"));

  const changeMemberRole = (id: string, role: ProjectRole) =>
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

  /**
   * Opens another project without taking the current one off the screen.
   *
   * The board already there stays and goes inert while the next one is read, so a
   * switch that lands quickly - a fast connection, a board small enough to answer
   * in a frame - shows no loading state at all. Inert is what makes leaving it up
   * safe: the client is scoped to the project being opened from the line below, so
   * a click landing on the old board in that window would write to the new one.
   *
   * `busy` is not set here. It means a write is in flight, and it is what puts
   * "saving" on the screen; a read that says it is saving would be both a lie and
   * the same flicker in a smaller box.
   */
  const openProject = async (id: string | null) => {
    const previousProjectId = board?.project.id ?? null;
    setUndoNotice(null);
    setActiveProjectId(id);
    syncProjectUrl(id);
    setProjectOpening(true);
    setError("");
    try {
      // Both halves are read before either is committed. Committing the board on its
      // own would put one project's work beside the other's ideas for a frame, which
      // is the flicker this avoids and a lie about whose garden you are looking at.
      const [nextBoard, nextIdeas] = await Promise.all([
        loadBoard(),
        view === "ideas" ? loadIdeas() : Promise.resolve(null),
      ]);
      applyBoard(nextBoard);
      setIdeas(nextIdeas);
    } catch (value) {
      // The old board is still a valid place to land if the next one cannot be read.
      // Put the request scope and URL back with it rather than leaving subsequent calls
      // aimed at a project that never opened.
      setActiveProjectId(previousProjectId);
      syncProjectUrl(previousProjectId);
      setError(value instanceof ApiError ? value.message : "The project could not be opened");
      throw value;
    } finally {
      setProjectOpening(false);
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

  const restoreProject = (id: string) => performSettings(() => mutate(`/api/projects/${id}/restore`, "POST"));

  const createCategory = (input: { name: string; color: string }) =>
    performSettings(() => mutate("/api/categories", "POST", input));
  const updateCategory = (slug: string, input: { name?: string; color?: string; position?: number }) =>
    performSettings(() => mutate(`/api/categories/${slug}`, "PATCH", input));
  const deleteCategory = (slug: string) => performSettings(() => mutate(`/api/categories/${slug}`, "DELETE"));

  const createField = (input: { label: string; type: FieldType; options?: string[]; showOnTile?: boolean }) =>
    performSettings(() => mutate("/api/fields", "POST", input));
  const updateField = (
    key: string,
    input: { label?: string; type?: FieldType; options?: string[]; showOnTile?: boolean; position?: number },
  ) => performSettings(() => mutate(`/api/fields/${key}`, "PATCH", input));
  const deleteField = (key: string) => performSettings(() => mutate(`/api/fields/${key}`, "DELETE"));

  const createChapter = (input: { name: string; startsOn?: string | null; endsOn?: string | null }) =>
    performSettings(() => mutate("/api/chapters", "POST", input));
  const updateChapter = (slug: string, input: Record<string, unknown>) =>
    performSettings(() => mutate(`/api/chapters/${slug}`, "PATCH", input));
  /** Closing decides what happens to unfinished work, so the server does it as one act. */
  const closeChapter = (slug: string, rollover: string) =>
    performSettings(() => mutate(`/api/chapters/${slug}/close`, "POST", { rollover }));

  const deleteChapter = (slug: string) => performSettings(() => mutate(`/api/chapters/${slug}`, "DELETE"));
  const setChaptersEnabled = (enabled: boolean) =>
    performSettings(() =>
      mutate(`/api/projects/${board?.project.id}`, "PATCH", { chaptersEnabled: enabled }),
    );

  const logout = async () => {
    await request("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    setBoard(null);
    setIdeas(null);
    setSessionState({ status: "anonymous" });
  };

  if (error && !sessionState) {
    return (
      <div className="loading-screen">
        <span className="brand-mark">g</span>
        <p>{error}</p>
        <button className="quiet-button" onClick={() => location.reload()} type="button">
          retry
        </button>
      </div>
    );
  }
  if (!sessionState || (sessionState.status === "authenticated" && !board)) {
    return (
      <div className="loading-screen">
        <span className="brand-mark pulse">g</span>
        <p>opening grimoire...</p>
      </div>
    );
  }
  if (sessionState.status === "setup_required") {
    return <AuthScreen mode="setup" onAuthenticated={onAuthenticated} />;
  }
  if (sessionState.status === "anonymous") {
    const parameters = new URLSearchParams(location.search);
    const invite = parameters.get("invite") ?? undefined;
    return (
      <AuthScreen
        inviteCode={invite}
        mode={invite ? "register" : "login"}
        onAuthenticated={onAuthenticated}
        oidc={sessionState.oidc}
        // A provider sign-in that failed comes back as a redirect carrying its reason, since
        // there is no fetch left to reject by the time the browser is here again.
        providerError={parameters.get("signin_error") ?? undefined}
      />
    );
  }
  if (!board) return null;

  return (
    <>
      {error && (
        <div className="error-banner global-error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")} type="button">
            ×
          </button>
        </div>
      )}
      {undoNotice && (
        <UndoToast notice={undoNotice} onDismiss={dismissUndo} onUndo={() => void undoLastChange()} />
      )}
      {/*
       * Inert rather than unmounted while the next project loads - see openProject.
       * `display: contents` keeps this wrapper out of the layout, so the board shell
       * is still the child of the body it was written to be.
       */}
      <div className="board-swap" inert={projectOpening}>
        <Board
          away={awayState}
          board={board}
          busy={busy}
          categoryActions={{ create: createCategory, update: updateCategory, remove: deleteCategory }}
          fieldActions={{ create: createField, update: updateField, remove: deleteField }}
          chapterActions={{
            create: createChapter,
            update: updateChapter,
            close: closeChapter,
            remove: deleteChapter,
          }}
          ideas={ideas}
          key={board.project.id}
          onChangeAvatar={changeAvatar}
          onChangeName={changeName}
          onChangePassword={changePassword}
          onRemoveAvatar={removeAvatar}
          onArchive={archivePage}
          onCreate={createPage}
          onAddMember={addMember}
          onCreateInvite={createInvite}
          onCreateIdea={createIdea}
          online={online}
          onLoadActivity={loadActivity}
          onLoadDiscussion={loadDiscussion}
          onAsk={askOnPage}
          onReply={replyOnPage}
          onSetAnswered={answerOnPage}
          onSeeDiscussion={seeDiscussion}
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
          projectActions={{
            select: selectProject,
            create: createProject,
            rename: renameProject,
            archive: archiveProject,
          }}
          projectSettingsActions={{
            rename: (name) => renameProject(board.project.id, name),
            setDescription: (description) => describeProject(board.project.id, description),
            setChaptersEnabled,
            setEstimatesEnabled: (enabled) =>
              performSettings(() =>
                mutate(`/api/projects/${board.project.id}`, "PATCH", { estimatesEnabled: enabled }),
              ),
            setDiscordWebhook: (webhook) =>
              performSettings(() =>
                mutate(`/api/projects/${board.project.id}`, "PATCH", { discordWebhook: webhook }),
              ),
            setRecapOnClose: (enabled) =>
              performSettings(() =>
                mutate(`/api/projects/${board.project.id}`, "PATCH", { recapOnClose: enabled }),
              ),
            setGithubRepo: (repo) =>
              performSettings(() =>
                mutate(`/api/projects/${board.project.id}`, "PATCH", { githubRepo: repo }),
              ),
            setGithubToken: (token) =>
              performSettings(() =>
                mutate(`/api/projects/${board.project.id}`, "PATCH", { githubToken: token }),
              ),
            archive: () => archiveProject(board.project.id),
            restore: restoreProject,
          }}
          view={view}
        />
      </div>
      {projectOpeningSlow && (
        <div className="loading-screen over-board" role="status">
          <span className="brand-mark pulse">g</span>
          <p>opening project...</p>
        </div>
      )}
    </>
  );
}
