import { useEffect, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

function ExternalLink({ node: _node, ...props }: React.ComponentProps<"a"> & ExtraProps) {
  return <a {...props} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" />;
}

const MARKDOWN_COMPONENTS: Components = { a: ExternalLink };

/** Renders trusted-shape Markdown; raw HTML in the source is shown as text, never injected. */
export function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-body">
      <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>{markdown}</Markdown>
    </div>
  );
}

type Props = {
  label: string;
  editLabel: string;
  name: string;
  textareaLabel: string;
  placeholder: string;
  rows: number;
  value: string;
  onChange: (value: string) => void;
};

/**
 * Notes field that rests as rendered Markdown and edits as the plain textarea.
 *
 * Clicking anywhere in the rendered view opens the editor with the caret at the
 * end; the `edit` button does the same for keyboard and screen-reader use, and
 * links stay real links in both worlds. Leaving the textarea returns to the
 * rendered view. The parent owns the value and its autosave, so switching modes
 * never touches unsaved text.
 */
export function NotesField({ label, editLabel, name, textareaLabel, placeholder, rows, value, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  const startEditing = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) return;
    setEditing(true);
  };

  return (
    <div className="notes-field">
      <div className="notes-head">
        <span>{label}</span>
        {!editing && (
          <button aria-label={editLabel} className="text-button" onClick={() => setEditing(true)} type="button">
            edit
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          aria-label={textareaLabel}
          name={name}
          onBlur={() => setEditing(false)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setEditing(false);
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={rows}
          value={value}
        />
      ) : (
        <div className="notes-view" onClick={startEditing}>
          {value.trim() ? <MarkdownView markdown={value} /> : <p className="notes-placeholder">{placeholder}</p>}
        </div>
      )}
    </div>
  );
}
