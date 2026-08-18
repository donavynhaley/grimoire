import { useEffect, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { imageUrl, uploadImage } from "../api/client";
import { Growing } from "./Growing";
import { remarkObsidianEmbeds } from "./obsidian-embeds";

const REMARK_PLUGINS = [remarkGfm, remarkObsidianEmbeds];

function ExternalLink({ node: _node, ...props }: React.ComponentProps<"a"> & ExtraProps) {
  return <a {...props} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" />;
}

/**
 * Resolves the image references notes actually contain the way Obsidian would.
 *
 * Obsidian embeds arrive as bare file names, and hand-written relative paths such
 * as `images/goal.png` resolve by their final segment, so both find the project
 * images directory regardless of where the Markdown file itself lives. Absolute
 * URLs pass through untouched.
 */
export function resolveImageSource(src: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(src) || src.startsWith("/")) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // A malformed escape sequence is still a usable file name.
  }
  return imageUrl(decoded.split("/").pop() ?? decoded);
}

function EmbeddedImage({ node: _node, src, ...props }: React.ComponentProps<"img"> & ExtraProps) {
  if (typeof src !== "string" || !src) return null;
  return <img {...props} loading="lazy" src={resolveImageSource(src)} />;
}

const MARKDOWN_COMPONENTS: Components = { a: ExternalLink, img: EmbeddedImage };

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
  /** Names the image picker for whichever notes these are; defaults to a plain one. */
  addImageLabel?: string;
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
 * links stay real links in both worlds. Leaving the textarea for another control
 * returns to the rendered view, but switching to another application does not,
 * so going to fetch a screenshot never closes the editor. The parent owns the
 * value and its autosave, so switching modes never touches unsaved text.
 *
 * Pasting or dropping an image uploads it and embeds `![[name]]`, exactly the
 * reference Obsidian would create. Drops are accepted by the whole field in both
 * modes, since a drag usually begins while the notes are at rest. A placeholder
 * token holds the caret position while the upload runs, so typing during the
 * upload never misplaces the embed.
 */
export function NotesField({ label, editLabel, addImageLabel = "Add an image", name, textareaLabel, placeholder, rows, value, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

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

  const insertAtSelection = (text: string) => {
    const current = valueRef.current;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    onChange(current.slice(0, start) + text + current.slice(end));
    const caret = start + text.length;
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret));
  };

  const replaceToken = (token: string, replacement: string) => {
    const current = valueRef.current;
    if (!current.includes(token)) return;
    onChange(current.replace(token, replacement).replace(/\n{3,}/g, "\n\n"));
  };

  const importImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploadFailed(false);
    const tokens = images.map(() => `![[uploading-${Math.random().toString(36).slice(2, 8)}]]`);
    const separated = !textareaRef.current && valueRef.current.trim() ? `\n\n${tokens.join("\n")}` : tokens.join("\n");
    insertAtSelection(separated);
    setPendingUploads((count) => count + images.length);
    for (const [index, image] of images.entries()) {
      try {
        const { name: imageName } = await uploadImage(image);
        replaceToken(tokens[index], `![[${imageName}]]`);
      } catch {
        replaceToken(tokens[index], "");
        setUploadFailed(true);
      } finally {
        setPendingUploads((count) => count - 1);
      }
    }
  };

  const collectFiles = (list: FileList | null | undefined) => Array.from(list ?? []);
  const hasImage = (files: File[]) => files.some((file) => file.type.startsWith("image/"));
  const draggingFiles = (transfer: DataTransfer | null) => Boolean(transfer?.types.includes("Files"));

  return (
    <div
      className={dropActive ? "notes-field drop-active" : "notes-field"}
      onDragEnter={(event) => {
        if (!draggingFiles(event.dataTransfer)) return;
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragLeave={() => {
        if (dragDepth.current === 0) return;
        dragDepth.current -= 1;
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDragOver={(event) => {
        if (draggingFiles(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDropActive(false);
        const files = collectFiles(event.dataTransfer?.files);
        if (!hasImage(files)) return;
        event.preventDefault();
        if (!editing) setEditing(true);
        void importImages(files);
      }}
    >
      <div className="notes-head">
        <span>{label}</span>
        <span className="notes-tools">
          {pendingUploads > 0 && <span aria-live="polite" className="notes-upload">uploading image...</span>}
          {pendingUploads === 0 && uploadFailed && (
            <span aria-live="polite" className="notes-upload failed">image upload failed</span>
          )}
          {/*
            An image could only arrive by paste or by drop, and a phone can comfortably do
            neither: there is no drag between apps, and getting a screenshot onto the
            clipboard is several steps that end in the wrong app. This is the same upload,
            reached the way a phone actually holds pictures.
          */}
          <button
            aria-label={addImageLabel}
            className="text-button notes-add-image"
            onClick={() => imagePicker.current?.click()}
            type="button"
          >
            <span aria-hidden="true">+</span> image
          </button>
          <input
            accept="image/*"
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              const files = collectFiles(event.target.files);
              // The same input has to accept the same picture twice in a row.
              event.target.value = "";
              if (!hasImage(files)) return;
              if (!editing) setEditing(true);
              void importImages(files);
            }}
            multiple
            ref={imagePicker}
            tabIndex={-1}
            type="file"
          />
          {!editing && (
            <button aria-label={editLabel} className="text-button" onClick={() => setEditing(true)} type="button">
              edit
            </button>
          )}
        </span>
      </div>
      <Growing className="notes-body">
        {editing ? (
          <textarea
            aria-label={textareaLabel}
            name={name}
            onBlur={() => {
              if (document.hasFocus()) setEditing(false);
            }}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setEditing(false);
            }}
            onPaste={(event) => {
              const files = collectFiles(event.clipboardData?.files);
              if (!hasImage(files)) return;
              event.preventDefault();
              void importImages(files);
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
      </Growing>
    </div>
  );
}
