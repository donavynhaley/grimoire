import { useRef, useState } from "react";
import { uploadImage } from "../api/client";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";

type Props = {
  label: string;
  /** Names the way in for a keyboard, which is now a way to the caret rather than to a mode. */
  editLabel: string;
  /** Names the image picker for whichever notes these are; defaults to a plain one. */
  addImageLabel?: string;
  editorLabel: string;
  placeholder: string;
  rows: number;
  /**
   * Fills the height it is handed instead of growing with what is in it.
   *
   * The page editor is a frame rather than a document: nothing on it scrolls except the
   * notes, and the notes only do so because they are the one thing that can be longer
   * than the panel.
   */
  fill?: boolean;
  value: string;
  onChange: (value: string) => void;
};

/**
 * Notes as one surface that is always rendered and always writable.
 *
 * There is no longer a rendered view and an editor taking turns. Headings are headings,
 * emphasis is emphasis, embedded screenshots are pictures - and the syntax underneath any
 * of it appears only on the line the caret is on, which is Obsidian's Live Preview and the
 * reason none of this needs a mode. Clicking lands the caret where it was clicked because
 * the caret was always there to land; nothing is measured, swapped, or grown, so the box
 * this lives in never changes size and the rule about things travelling has nothing to do.
 *
 * Pasting or dropping an image uploads it and embeds `![[name]]`, exactly the reference
 * Obsidian would create. Drops are accepted by the whole field, since a drag usually
 * begins over the notes rather than over the caret, and a placeholder token holds the
 * spot while the upload runs so typing during it never misplaces the embed.
 */
export function NotesField({
  label,
  editLabel,
  addImageLabel = "Add an image",
  editorLabel,
  placeholder,
  rows,
  fill = false,
  value,
  onChange,
}: Props) {
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const editor = useRef<MarkdownEditorHandle | null>(null);
  const focused = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  /**
   * An embed arriving while the caret is elsewhere goes to the end, on its own line.
   * An embed arriving while someone is writing goes where they are writing.
   */
  const placeEmbeds = (tokens: string[]) => {
    const handle = editor.current;
    if (!handle) return;
    if (focused.current) {
      handle.insert(tokens.join("\n"));
      return;
    }
    const existing = valueRef.current;
    handle.focus(existing.length);
    handle.insert(existing.trim() ? `\n\n${tokens.join("\n")}` : tokens.join("\n"));
  };

  const importImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploadFailed(false);
    const tokens = images.map(() => `![[uploading-${Math.random().toString(36).slice(2, 8)}]]`);
    placeEmbeds(tokens);
    setPendingUploads((count) => count + images.length);
    for (const [index, image] of images.entries()) {
      try {
        const { name: imageName } = await uploadImage(image);
        editor.current?.replaceFirst(tokens[index]!, `![[${imageName}]]`);
      } catch {
        editor.current?.replaceFirst(tokens[index]!, "");
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
      className={["notes-field", fill && "fill", dropActive && "drop-active"].filter(Boolean).join(" ")}
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
        void importImages(files);
      }}
      style={{ "--notes-rows": rows } as React.CSSProperties}
    >
      <div className="notes-head">
        <span>{label}</span>
        <span className="notes-tools">
          {pendingUploads > 0 && (
            <span aria-live="polite" className="notes-upload">
              uploading image...
            </span>
          )}
          {pendingUploads === 0 && uploadFailed && (
            <span aria-live="polite" className="notes-upload failed">
              image upload failed
            </span>
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
              void importImages(files);
            }}
            multiple
            ref={imagePicker}
            tabIndex={-1}
            type="file"
          />
          {/*
            A pointer puts the caret where it clicks. This is the same destination for
            everyone else: the end of the notes, named, and one stop along the tab order
            rather than something to hunt for.
          */}
          <button
            aria-label={editLabel}
            className="text-button"
            onClick={() => editor.current?.focus(valueRef.current.length)}
            type="button"
          >
            edit
          </button>
        </span>
      </div>
      <div className="notes-body">
        <MarkdownEditor
          ariaLabel={editorLabel}
          fill={fill}
          onChange={onChange}
          onFocusChange={(next) => {
            focused.current = next;
          }}
          onPasteFiles={(files) => void importImages(files)}
          placeholder={placeholder}
          ref={editor}
          scrollerClass="notes-view"
          value={value}
        />
      </div>
    </div>
  );
}
