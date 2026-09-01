import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage, pasteURLAsLink } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { GFM } from "@lezer/markdown";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { livePreview } from "../lib/live-preview";

export type MarkdownEditorHandle = {
  /** Focuses the surface, optionally putting the caret at a source offset. */
  focus: (caret?: number) => void;
  /** Writes text over the current selection and leaves the caret after it. */
  insert: (text: string) => void;
  /** Swaps the first occurrence of a token, leaving the caret where it was. */
  replaceFirst: (token: string, replacement: string) => void;
};

type Props = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Fills the height it is handed and scrolls inside it, rather than growing. */
  fill?: boolean;
  /**
   * Shows the Markdown as it is written, with the live preview's drawing switched off.
   *
   * The document is the same either way - only what is drawn over it changes - so the caret,
   * the selection and the undo history all survive the swap.
   */
  source?: boolean;
  /**
   * Put on the box that actually scrolls, which is CodeMirror's own scroller rather than
   * anything React renders here. The notes are the one thing on the page editor allowed
   * to scroll, and naming that box is what lets the panel be measured against it.
   */
  scrollerClass?: string;
  onPasteFiles?: (files: File[]) => void;
  onFocusChange?: (focused: boolean) => void;
};

/**
 * Only the code inside a fence is coloured.
 *
 * Everything Markdown itself spells - the emphasis, the headings, the links - is drawn
 * as the thing it produces rather than as coloured syntax, so colouring it too would be
 * saying it twice. A fenced block is the one place where the characters are the content.
 */
const CODE_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, class: "cm-lp-token-keyword" },
  { tag: [tags.string, tags.special(tags.string)], class: "cm-lp-token-string" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "cm-lp-token-comment" },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-lp-token-number" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], class: "cm-lp-token-name" },
  { tag: [tags.typeName, tags.className], class: "cm-lp-token-type" },
]);

/**
 * The drawing that makes this surface Live Preview, declared once.
 *
 * CodeMirror extensions are declarations rather than instances, so every editor can share
 * these - and sharing them is what lets a reconfiguration back to the same drawing cost
 * nothing, which is what the mount-time one below is.
 */
const LIVE_PREVIEW = livePreview();

/** Wrapping a selection is how emphasis gets applied when the syntax is not on screen. */
function wrapSelection(view: EditorView, mark: string): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const already = text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2;
      const inner = already ? text.slice(mark.length, -mark.length) : text;
      const insert = already ? inner : `${mark}${text}${mark}`;
      // The words stay chosen either way, so the shortcut can be pressed twice to undo itself.
      const start = already ? range.from : range.from + mark.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(start, start + inner.length),
      };
    }),
  );
  return true;
}

function editorExtensions(props: {
  ariaLabel: string;
  placeholder: string;
  /** Holds the live preview, so the mode can be swapped without rebuilding the editor. */
  preview: Compartment;
  source: boolean;
  onChange: (value: string) => void;
  onPasteFiles?: (files: File[]) => void;
  onFocusChange?: (focused: boolean) => void;
}): Extension[] {
  return [
    history(),
    // Markdown's own Enter and Backspace come first, so a list carries on rather than
    // simply breaking the line.
    keymap.of([
      ...markdownKeymap,
      { key: "Mod-b", run: (view) => wrapSelection(view, "**") },
      { key: "Mod-i", run: (view) => wrapSelection(view, "*") },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    markdown({ base: markdownLanguage, extensions: [GFM] }),
    // A URL pasted over chosen words is a link around those words, as it is in Obsidian.
    pasteURLAsLink,
    syntaxHighlighting(CODE_HIGHLIGHT),
    props.preview.of(props.source ? [] : LIVE_PREVIEW),
    EditorView.lineWrapping,
    placeholderExtension(props.placeholder),
    EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) props.onChange(update.state.doc.toString());
      if (update.focusChanged) props.onFocusChange?.(update.view.hasFocus);
    }),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key !== "Escape") return false;
        // Leaving the surface is what Escape did when the editor was a separate box, and
        // the panel behind it still needs its own Escape to close.
        event.stopPropagation();
        view.contentDOM.blur();
        return true;
      },
      paste(event, view) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some((file) => file.type.startsWith("image/"))) return false;
        event.preventDefault();
        props.onPasteFiles?.(files);
        view.focus();
        return true;
      },
    }),
  ];
}

/**
 * The one surface notes are read and written on.
 *
 * It is a controlled component in the same shape the textarea was - a value and an
 * `onChange` - so the autosave and conflict handling above it never learned that the
 * editor changed underneath them. A value arriving from outside (a teammate's edit
 * adopted into an untouched field) is written into the document without disturbing
 * where the caret is, since that edit is not this reader's.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  {
    ariaLabel,
    value,
    onChange,
    placeholder,
    fill = false,
    source = false,
    scrollerClass,
    onPasteFiles,
    onFocusChange,
  },
  ref,
) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Held in state rather than a memo: the compartment is the handle the mode is swapped
  // by, and React is free to throw a memo away, which would quietly strand the swap.
  const [preview] = useState(() => new Compartment());
  const latest = useRef({ onChange, onPasteFiles, onFocusChange, source });
  latest.current = { onChange, onPasteFiles, onFocusChange, source };
  /**
   * The text this editor has announced, most recent last.
   *
   * A controlled value comes back as a prop a render later, by which time the document has
   * usually moved on again - somebody types faster than React re-renders. Every one of
   * those late arrivals is this editor's own writing coming back, and writing it into the
   * document would undo the characters typed since. An edit that genuinely came from
   * somewhere else is the one value that was never announced from here, so that is the
   * only one worth overwriting the document for.
   */
  const emitted = useRef<string[]>([value]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is built once and value is only its seed document; adding value would rebuild CodeMirror on every keystroke and throw away the caret and the undo history
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions({
          ariaLabel,
          placeholder,
          preview,
          source: latest.current.source,
          onChange: (next) => {
            emitted.current.push(next);
            // Only enough history to outlast React's lag, never enough to be a copy of the notes.
            if (emitted.current.length > 50) emitted.current.splice(0, emitted.current.length - 50);
            latest.current.onChange(next);
          },
          onPasteFiles: (files) => latest.current.onPasteFiles?.(files),
          onFocusChange: (focused) => latest.current.onFocusChange?.(focused),
        }),
      }),
    });
    if (scrollerClass) editor.scrollDOM.classList.add(scrollerClass);
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; everything that changes reaches it through a ref or a
    // transaction, because rebuilding it would throw away the caret and the undo history.
  }, [ariaLabel, fill, placeholder, preview, scrollerClass]);

  useEffect(() => {
    // The mode is the one thing about this surface a reader changes while using it, so it
    // is swapped inside the compartment rather than by building a second editor: the words
    // are the same words, and the caret they were reading from is the same caret.
    view.current?.dispatch({ effects: preview.reconfigure(source ? [] : LIVE_PREVIEW) });
  }, [preview, source]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const echo = emitted.current.lastIndexOf(value);
    if (echo !== -1) {
      // Everything announced before it has been overtaken and will never arrive again.
      emitted.current.splice(0, echo);
      return;
    }
    const current = editor.state.doc.toString();
    if (current === value) return;
    emitted.current = [value];
    const selection = editor.state.selection.main;
    const anchor = Math.min(selection.anchor, value.length);
    const head = Math.min(selection.head, value.length);
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor, head },
    });
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: (caret?: number) => {
      const editor = view.current;
      if (!editor) return;
      editor.focus();
      if (caret === undefined) return;
      const at = Math.max(0, Math.min(caret, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    },
    insert: (text: string) => {
      const editor = view.current;
      if (!editor) return;
      const range = editor.state.selection.main;
      editor.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
      });
    },
    replaceFirst: (token: string, replacement: string) => {
      const editor = view.current;
      if (!editor) return;
      const at = editor.state.doc.toString().indexOf(token);
      if (at === -1) return;
      editor.dispatch({ changes: { from: at, to: at + token.length, insert: replacement } });
    },
  }));

  return <div className={fill ? "markdown-editor fill" : "markdown-editor"} ref={host} />;
});
