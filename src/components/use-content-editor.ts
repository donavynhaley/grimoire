import { useCallback, useEffect, useRef, useState } from "react";
import { editConflict } from "../api/client";

export type ContentDraft = { title: string; description: string };
export type ContentField = keyof ContentDraft;

export type ContentConflict = {
  field: ContentField;
  /** What the record actually holds now, so the reader can choose without guessing. */
  theirs: string;
  message: string;
};

type Options = {
  /** The record as the workspace currently knows it, refreshed by live updates. */
  remote: ContentDraft;
  /** Changing this means a different record is being edited, so the draft starts over. */
  resetKey: string;
  save: (input: Record<string, unknown>) => Promise<unknown>;
};

export type ContentEditor = {
  title: string;
  description: string;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  saveState: string;
  conflict: ContentConflict | null;
  /** The field a teammate's change was just adopted into, for a moment after it lands. */
  adopted: ContentField | null;
  keepMine: () => void;
  useTheirs: () => void;
  /** Saves anything outstanding. Resolves false when the editor should stay open. */
  flush: () => Promise<boolean>;
};

const SAVE_DELAY = 500;
const ADOPTED_NOTICE_MS = 6000;

/**
 * Editing state for a title-and-notes record that other people can change at the same time.
 *
 * Three rules keep a save from destroying writing it never read:
 *
 * - only fields the reader actually changed are sent, so editing a title cannot carry
 *   a stale copy of the notes along with it;
 * - each field sent carries the value the reader was working from, and the server refuses
 *   the write when storage has moved on;
 * - a field the reader has not touched adopts incoming changes instead of sitting on a
 *   stale copy that would collide later.
 *
 * While a refusal is unresolved nothing is written at all: the reader chooses.
 */
export function useContentEditor({ remote, resetKey, save }: Options): ContentEditor {
  const [draft, setDraft] = useState<ContentDraft>(remote);
  const [saveState, setSaveState] = useState("saved");
  const [conflict, setConflict] = useState<ContentConflict | null>(null);
  const [adopted, setAdopted] = useState<ContentField | null>(null);

  // The values storage held when this draft started, compared per field so an untouched
  // field can never manufacture a collision.
  const baselineRef = useRef<ContentDraft>(remote);
  const draftRef = useRef(draft);
  const conflictRef = useRef(conflict);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  const recordRef = useRef(resetKey);
  const queueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  draftRef.current = draft;
  conflictRef.current = conflict;
  saveRef.current = save;

  const write = useCallback(async (): Promise<boolean> => {
    const next = trimmed(draftRef.current);
    const changes = changedFields(next, baselineRef.current);
    if (!next.title || changes.length === 0) return true;

    setSaveState("saving...");
    const payload: Record<string, unknown> = {};
    for (const field of changes) {
      payload[field] = next[field];
      payload[field === "title" ? "expectedTitle" : "expectedDescription"] = baselineRef.current[field];
    }

    try {
      await saveRef.current(payload);
      for (const field of changes) baselineRef.current[field] = next[field];
      const latest = trimmed(draftRef.current);
      setSaveState(changedFields(latest, baselineRef.current).length === 0 ? "saved" : "changes pending");
      return true;
    } catch (error) {
      const refusal = editConflict<ContentDraft>(error);
      if (!refusal) {
        setSaveState("save failed");
        return false;
      }
      // Adopting their value as the new baseline means "keep mine" is an ordinary save
      // and "use theirs" is simply no change at all.
      const theirs = refusal.current[refusal.field];
      baselineRef.current[refusal.field] = theirs;
      setConflict({ field: refusal.field, theirs, message: refusal.error });
      setSaveState("changed by someone else");
      return false;
    }
  }, []);

  /**
   * Saves run one at a time.
   *
   * Closing an editor while its debounced save is still in the air used to send a second
   * write carrying the same expectation, which the server would rightly refuse - a
   * conflict with nobody but itself. Queued writes recompute what is left to send, so the
   * second one usually finds nothing to do.
   */
  const commit = useCallback((): Promise<boolean> => {
    const next = queueRef.current.then(write, write);
    queueRef.current = next.then(
      () => true,
      () => true,
    );
    return next;
  }, [write]);

  // A different record means a different draft; nothing survives the switch.
  useEffect(() => {
    if (recordRef.current === resetKey) return;
    recordRef.current = resetKey;
    if (timerRef.current) clearTimeout(timerRef.current);
    baselineRef.current = { ...remote };
    setDraft(remote);
    setConflict(null);
    setAdopted(null);
    setSaveState("saved");
  }, [remote, resetKey]);

  // A teammate's change lands in any field the reader is not currently rewriting.
  useEffect(() => {
    if (recordRef.current !== resetKey || conflictRef.current) return;
    const current = trimmed(draftRef.current);
    let landed: ContentField | null = null;
    for (const field of ["title", "description"] as const) {
      if (current[field] !== baselineRef.current[field]) continue;
      if (remote[field] === baselineRef.current[field]) continue;
      baselineRef.current[field] = remote[field];
      setDraft((value) => ({ ...value, [field]: remote[field] }));
      landed = field;
    }
    if (landed) setAdopted(landed);
  }, [remote.title, remote.description, resetKey]);

  useEffect(() => {
    if (!adopted) return;
    const timeout = setTimeout(() => setAdopted(null), ADOPTED_NOTICE_MS);
    return () => clearTimeout(timeout);
  }, [adopted]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = trimmed(draft);
    if (!next.title) {
      setSaveState("title required");
      return;
    }
    // Nothing is written while a refusal is unresolved; the reader decides what wins.
    if (conflict) return;
    if (changedFields(next, baselineRef.current).length === 0) {
      setSaveState("saved");
      return;
    }
    setSaveState("changes pending");
    timerRef.current = setTimeout(() => void commit(), SAVE_DELAY);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [commit, conflict, draft]);

  const keepMine = useCallback(() => {
    setConflict(null);
    setAdopted(null);
    void commit();
  }, [commit]);

  const useTheirs = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    setDraft((value) => ({ ...value, [current.field]: current.theirs }));
    setConflict(null);
    setAdopted(current.field);
  }, []);

  const flush = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!trimmed(draftRef.current).title) {
      setSaveState("title required");
      return false;
    }
    if (conflictRef.current) return false;
    return commit();
  }, [commit]);

  return {
    title: draft.title,
    description: draft.description,
    setTitle: (value) => setDraft((current) => ({ ...current, title: value })),
    setDescription: (value) => setDraft((current) => ({ ...current, description: value })),
    saveState,
    conflict,
    adopted,
    keepMine,
    useTheirs,
    flush,
  };
}

function trimmed(draft: ContentDraft): ContentDraft {
  return { title: draft.title.trim(), description: draft.description.trim() };
}

function changedFields(draft: ContentDraft, baseline: ContentDraft): ContentField[] {
  return (["title", "description"] as const).filter((field) => draft[field] !== baseline[field]);
}
