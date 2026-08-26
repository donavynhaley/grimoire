import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { embedDimensions, resolveImageSource } from "./image-source";
import { plainTextFromMarkdown } from "./markdown-text";

/**
 * Obsidian's Live Preview, as an editing surface rather than a mode.
 *
 * Notes used to rest as rendered Markdown and swap wholesale into a textarea, which
 * is Obsidian's *source mode*: the price of touching one word was seeing every other
 * word as syntax. Here there is one surface and it is always rendered. The syntax that
 * produced a piece of formatting is hidden until the caret is on the line that holds
 * it, at which point that line - and only that line - shows its workings.
 *
 * Everything is driven off the parsed Markdown tree rather than off text patterns, so
 * a `**` inside a code fence stays two asterisks, exactly as it does in Obsidian and
 * exactly as `remarkObsidianEmbeds` already treats embeds. Nothing here ever builds
 * HTML from note text: the widgets are constructed element by element, so a note that
 * contains markup still shows that markup as characters.
 */

/** The syntax that produced formatting, hidden while the caret is elsewhere. */
const HIDDEN = Decoration.replace({});

const STRONG = Decoration.mark({ class: "cm-lp-strong" });
const EMPHASIS = Decoration.mark({ class: "cm-lp-emphasis" });
const STRIKETHROUGH = Decoration.mark({ class: "cm-lp-strikethrough" });
const INLINE_CODE = Decoration.mark({ class: "cm-lp-code" });
const QUOTE_LINE = Decoration.line({ class: "cm-lp-quote" });
const CODE_LINE = Decoration.line({ class: "cm-lp-code-line" });
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `cm-lp-heading cm-lp-h${level}` }));

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | undefined,
    readonly height: number | undefined,
    readonly block: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.width === this.width
      && other.height === this.height && other.block === this.block;
  }

  toDOM(): HTMLElement {
    const image = document.createElement("img");
    image.className = this.block ? "cm-lp-image block" : "cm-lp-image";
    image.src = resolveImageSource(this.src);
    image.alt = this.alt;
    image.setAttribute("loading", "lazy");
    if (this.width) image.width = this.width;
    if (this.height) image.height = this.height;
    return image;
  }
}

/**
 * A checkbox that is the task, not a picture of one.
 *
 * It stays a live control even while its line shows its syntax, because a checklist
 * someone is reading is a checklist they are ticking, and having to leave the line to
 * do it would be the swap all over again in miniature.
 */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const marker = view.state.doc.sliceString(this.from, this.from + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-lp-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement("hr");
    rule.className = "cm-lp-rule";
    return rule;
  }
}

/**
 * A table drawn as a table.
 *
 * Hiding syntax character by character is enough for everything that formats a run of
 * words, but a table is a shape: there is no arrangement of hidden pipes that makes
 * source rows into columns. So the whole block is replaced by a real table while the
 * caret is outside it, and handed back as text the moment the caret moves in - which is
 * also the only way to edit one that does not need a table editor.
 *
 * Cell text is reduced with the same reader the board tiles use, so a cell shows its
 * words rather than its syntax without a second Markdown renderer existing to disagree
 * with the first.
 */
class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-lp-table";
    const table = document.createElement("table");
    const rows = this.source.split("\n").filter((line) => line.trim());
    const alignments = rows[1] ? columnAlignments(rows[1]) : [];
    const head = document.createElement("thead");
    const body = document.createElement("tbody");

    rows.forEach((row, index) => {
      if (index === 1) return;
      const cells = splitRow(row);
      const element = document.createElement("tr");
      cells.forEach((cell, column) => {
        const target = document.createElement(index === 0 ? "th" : "td");
        target.textContent = plainTextFromMarkdown(cell);
        const alignment = alignments[column];
        if (alignment) target.style.textAlign = alignment;
        element.append(target);
      });
      (index === 0 ? head : body).append(element);
    });

    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }
}

function splitRow(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function columnAlignments(delimiter: string): (string | null)[] {
  return splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * The lines whose workings are showing.
 *
 * An unfocused editor has none: notes nobody is writing in are notes someone is
 * reading, and they read as the document. Every selection contributes the lines it
 * touches, so widening a selection across a heading reveals that heading too.
 */
function activeLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  if (!focused) return lines;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function revealed(state: EditorState, active: Set<number>, from: number, to: number): boolean {
  if (active.size === 0) return false;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  for (let line = first; line <= last; line += 1) if (active.has(line)) return true;
  return false;
}

/** Whether a position sits inside code, where Markdown stops meaning anything. */
function insideCode(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent as never) {
    if (/Code/.test(node.name)) return true;
    if (!node.parent) return false;
  }
  return false;
}

const EMBED_PATTERN = /!\[\[([^\][\n|]+?)(?:\|([^\][\n]+?))?\]\]/g;

type Built = { decorations: DecorationSet; atomic: DecorationSet };

function build(state: EditorState, focused: boolean): Built {
  const active = activeLines(state, focused);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  // Ranges a block widget has already claimed, so nothing decorates inside one.
  const claimed: Array<[number, number]> = [];
  const isClaimed = (from: number) => claimed.some(([start, end]) => from >= start && from < end);

  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (isClaimed(node.from)) return false;
      const show = revealed(state, active, node.from, node.to);

      if (node.name === "Table") {
        if (show) return undefined;
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(Math.min(node.to, state.doc.length));
        const source = state.doc.sliceString(first.from, last.to);
        decorations.push(Decoration.replace({ widget: new TableWidget(source), block: true }).range(first.from, last.to));
        atomic.push(HIDDEN.range(first.from, last.to));
        claimed.push([first.from, last.to]);
        return false;
      }

      if (node.name === "HorizontalRule") {
        if (show) return undefined;
        const line = state.doc.lineAt(node.from);
        decorations.push(Decoration.replace({ widget: new RuleWidget(), block: true }).range(line.from, line.to));
        atomic.push(HIDDEN.range(line.from, line.to));
        claimed.push([line.from, line.to]);
        return false;
      }

      const heading = node.name.match(/^(?:ATX|Setext)Heading([1-6])$/);
      if (heading) {
        decorations.push(HEADING_LINES[Number(heading[1]) - 1].range(state.doc.lineAt(node.from).from));
        return undefined;
      }

      if (node.name === "Blockquote") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
        for (let line = first; line <= last; line += 1) {
          decorations.push(QUOTE_LINE.range(state.doc.line(line).from));
        }
        return undefined;
      }

      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
        for (let line = first; line <= last; line += 1) {
          decorations.push(CODE_LINE.range(state.doc.line(line).from));
        }
        return undefined;
      }

      if (node.name === "StrongEmphasis") decorations.push(STRONG.range(node.from, node.to));
      if (node.name === "Emphasis") decorations.push(EMPHASIS.range(node.from, node.to));
      if (node.name === "Strikethrough") decorations.push(STRIKETHROUGH.range(node.from, node.to));
      if (node.name === "InlineCode") decorations.push(INLINE_CODE.range(node.from, node.to));

      if (node.name === "TaskMarker") {
        const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
        decorations.push(Decoration.replace({ widget: new TaskWidget(checked, node.from) }).range(node.from, node.to));
        return false;
      }

      if (show) return undefined;

      // From here down is syntax that only exists to produce what is already drawn.
      if (node.name === "HeaderMark") {
        const line = state.doc.lineAt(node.from);
        // Setext underlines are a whole line of syntax; ATX hashes take the space after them.
        if (node.from === line.from && node.to === line.to) return false;
        const after = /\s/.test(state.doc.sliceString(node.to, node.to + 1)) ? node.to + 1 : node.to;
        decorations.push(HIDDEN.range(node.from, after));
        return false;
      }

      if (node.name === "EmphasisMark" || node.name === "StrikethroughMark" || node.name === "QuoteMark") {
        decorations.push(HIDDEN.range(node.from, node.to));
        return false;
      }

      if (node.name === "CodeMark" && !insideFence(state, node.from)) {
        decorations.push(HIDDEN.range(node.from, node.to));
        return false;
      }

      if (node.name === "ListMark") {
        const mark = state.doc.sliceString(node.from, node.to);
        if (/^[-*+]$/.test(mark)) {
          decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
        }
        return false;
      }

      if (node.name === "Link") {
        const url = urlOf(state, node.node);
        if (url) decorations.push(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": url } }).range(node.from, node.to));
        for (const child of childrenOf(node.node)) {
          if (child.name === "LinkMark" || child.name === "URL" || child.name === "LinkTitle") {
            decorations.push(HIDDEN.range(child.from, child.to));
          }
        }
        return false;
      }

      if (node.name === "Image") {
        // Obsidian's own embeds are handled below; this is the plain Markdown form.
        if (state.doc.sliceString(node.from, node.from + 3) === "![[") return false;
        const url = urlOf(state, node.node);
        if (!url) return false;
        const line = state.doc.lineAt(node.from);
        const alone = line.text.trim() === state.doc.sliceString(node.from, node.to).trim();
        decorations.push(
          Decoration.replace({ widget: new ImageWidget(url, altOf(state, node.node), undefined, undefined, alone) })
            .range(node.from, node.to),
        );
        atomic.push(HIDDEN.range(node.from, node.to));
        return false;
      }

      return undefined;
    },
  });

  // Obsidian embeds are not Markdown, so no parser reports them; they are found in the
  // text and then disqualified by the tree wherever Markdown has stopped applying.
  const text = state.doc.toString();
  EMBED_PATTERN.lastIndex = 0;
  for (let match = EMBED_PATTERN.exec(text); match; match = EMBED_PATTERN.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isClaimed(start) || insideCode(state, start)) continue;
    if (revealed(state, active, start, end)) continue;
    const { width, height, alt } = embedDimensions(match[2]?.trim());
    const line = state.doc.lineAt(start);
    const alone = line.text.trim() === match[0];
    decorations.push(
      Decoration.replace({ widget: new ImageWidget(match[1].trim(), alt, width, height, alone) }).range(start, end),
    );
    atomic.push(HIDDEN.range(start, end));
  }

  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function urlOf(state: EditorState, node: SyntaxNode): string | null {
  const url = childrenOf(node).find((child) => child.name === "URL");
  return url ? state.doc.sliceString(url.from, url.to) : null;
}

function altOf(state: EditorState, node: SyntaxNode): string {
  const marks = childrenOf(node).filter((child) => child.name === "LinkMark");
  if (marks.length < 2) return "";
  return state.doc.sliceString(marks[0].to, marks[1].from);
}

/** Fence backticks are the block's own shape, and hiding them collapses it. */
function insideFence(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent as never) {
    if (node.name === "FencedCode") return true;
    if (!node.parent) return false;
  }
  return false;
}

/**
 * Whether anyone is holding a caret in here, kept in the state rather than read from the
 * view, because the decorations that depend on it are computed as part of the state.
 */
const setFocused = StateEffect.define<boolean>();

const focusedField = StateField.define<boolean>({
  create: () => false,
  update(focused, transaction) {
    for (const effect of transaction.effects) if (effect.is(setFocused)) return effect.value;
    return focused;
  },
});

/**
 * The drawn document, rebuilt whenever what it depends on moves.
 *
 * It is a state field rather than a view plugin because a table and a rule are replaced
 * as whole blocks, and CodeMirror only accepts block replacements from the state - they
 * change how much vertical space a line takes, which the viewport has to know before it
 * can decide what the viewport is.
 */
const livePreviewField = StateField.define<Built>({
  create: (state) => build(state, false),
  update(built, transaction) {
    const focusChanged = transaction.effects.some((effect) => effect.is(setFocused));
    if (!transaction.docChanged && !transaction.selection && !focusChanged) return built;
    return build(transaction.state, transaction.state.field(focusedField));
  },
  provide: (field) => EditorView.decorations.from(field, (built) => built.decorations),
});

const trackFocus = EditorView.updateListener.of((update) => {
  if (!update.focusChanged) return;
  update.view.dispatch({ effects: setFocused.of(update.view.hasFocus) });
});

/**
 * Links stay links.
 *
 * A note is read far more often than it is rewritten, and the thing people do with a
 * reference in one is follow it. Clicking it opens it rather than placing a caret in it,
 * which is what the rendered view did before there was one surface, and the caret is
 * still one keystroke away on either side.
 */
const followLinks = EditorView.domEventHandlers({
  mousedown(event) {
    const target = event.target as HTMLElement | null;
    const link = target?.closest<HTMLElement>(".cm-lp-link");
    const href = link?.dataset.href;
    if (!href) return false;
    event.preventDefault();
    window.open(href, "_blank", "noreferrer");
    return true;
  },
});

export function livePreview(): Extension {
  return [
    // Order matters: the drawn document reads the focus that the field before it settled.
    focusedField,
    livePreviewField,
    trackFocus,
    followLinks,
    EditorView.atomicRanges.of((view) => view.state.field(livePreviewField).atomic),
  ];
}
