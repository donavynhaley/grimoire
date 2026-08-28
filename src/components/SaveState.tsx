import type { AuditEvent } from "../../shared/types";
import type { ContentEditor } from "./use-content-editor";

/**
 * The autosave line, plus the two moments where someone else is in the same record:
 * a change quietly adopted into a field nobody was rewriting, and a refused save that
 * only the reader can settle.
 */
export function SaveState({ editor, who }: { editor: ContentEditor; who: string | null }) {
  const { adopted, conflict, saveState } = editor;
  return (
    <>
      <div aria-live="polite" className={`autosave-state ${saveState.replaceAll(" ", "-")}`}>
        <span className="autosave-dot" />
        {saveState}
        {adopted && !conflict && (
          <span className="adopted-note">
            {adopted === "title" ? "title" : "notes"} updated{who ? ` by ${who}` : ""}
          </span>
        )}
      </div>
      {conflict && (
        <div className="conflict-bar" role="alert">
          <div className="conflict-copy">
            <strong>
              {who ?? "Someone"} changed {conflict.field === "title" ? "this title" : "these notes"} while you
              were writing
            </strong>
            <p className="conflict-theirs">{conflict.theirs || "(empty)"}</p>
          </div>
          <div className="conflict-actions">
            <button className="quiet-button" onClick={editor.useTheirs} type="button">
              use theirs
            </button>
            <button className="primary-button compact" onClick={editor.keepMine} type="button">
              keep mine
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Names the last person other than the reader to touch this record.
 *
 * The activity log already knows who acted, so a collision can name someone without
 * adding an author field to the Markdown that people edit by hand.
 */
export function otherEditorName(events: AuditEvent[] | null, currentUserId: string): string | null {
  return events?.find((event) => event.actorId && event.actorId !== currentUserId)?.actorName ?? null;
}
