import { useRef, useState } from "react";
import { uploadImage } from "../api/client";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";

type Props = {
  label: string;
  /** Names the control while it offers the Markdown: "Edit notes", and the caret with it. */
  editLabel: string;
  /** Names the same control while it offers the drawn document back: "View notes". */
  viewLabel: string;
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
 * Headings are headings, emphasis is emphasis, embedded screenshots are pictures - and the
 * syntax underneath any of it appears only on the line the caret is on, which is Obsidian's
 * Live Preview and the reason reading and writing are not two modes. Clicking lands the
 * caret where it was clicked because the caret was always there to land; nothing is
 * measured, swapped, or grown, so the box this lives in never changes size and the rule
 * about things travelling has nothing to do.
 *
 * `edit` asks for the Markdown itself - Obsidian's source mode - for the times the drawing
 * is in the way of the thing being written: a stubborn table, a link whose target matters,
 * a page being pasted in from somewhere else. It is the same document underneath and the
 * same caret in it, so the word on the control swaps to `view` and the way back is the
 * click that got here.
 *
 * Pasting or dropping an image uploads it and embeds `![[name]]`, exactly the reference
 * Obsidian would create. Drops are accepted by the whole field, since a drag usually
 * begins over the notes rather than over the caret, and a placeholder token holds the
 * spot while the upload runs so typing during it never misplaces the embed.
 */
export function NotesField({
  label,
  editLabel,
  viewLabel,
  addImageLabel = "Add an image",
  editorLabel,
  placeholder,
  rows,
  fill = false,
  value,
  onChange,
}: Props) {
  const [source, setSource] = useState(false);
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
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler is not an affordance a keyboard user needs to reach - it is dismissal, focus bookkeeping or a drop target - and every one of these surfaces has a real focusable control that does the same job
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
            The word on this control names what a click will do rather than what is on
            screen, the way a play button does, so it swaps with the mode instead of
            carrying `aria-pressed` under a fixed name (UI-5) - a pressed state under the
            word "view" would contradict the word somebody can read.

            A pointer still puts the caret where it clicks. Asking for the Markdown is
            asking to write in it, so the caret comes along, at the same destination this
            control has always offered a keyboard: the end of the notes.
          */}
          <button
            aria-label={source ? viewLabel : editLabel}
            className="text-button"
            onClick={() => {
              const showingSource = !source;
              setSource(showingSource);
              if (showingSource) editor.current?.focus(valueRef.current.length);
            }}
            type="button"
          >
            {source ? "view" : "edit"}
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
          source={source}
          value={value}
        />
      </div>
    </div>
  );
}
