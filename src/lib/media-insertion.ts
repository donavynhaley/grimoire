import { type Extension, MapMode, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export type MediaUploadStatus = {
  filename: string;
  message: string;
  percent?: number;
  failed?: boolean;
  retry?: () => void;
  dismiss?: () => void;
};
export type MediaInsertion = {
  insert: (text: string) => void;
  cancel: () => void;
  update: (status: MediaUploadStatus) => void;
};
type Reservation = { position: number; status?: MediaUploadStatus };
const reserve = StateEffect.define<{ id: symbol; reservation: Reservation }>();
const release = StateEffect.define<symbol>();
const progress = StateEffect.define<{ id: symbol; status: MediaUploadStatus }>();

const widgetIds = new WeakMap<HTMLElement, symbol>();

class UploadWidget extends WidgetType {
  constructor(
    readonly id: symbol,
    readonly status: MediaUploadStatus,
  ) {
    super();
  }
  override eq(other: UploadWidget): boolean {
    return (
      this.id === other.id &&
      this.status.filename === other.status.filename &&
      this.status.message === other.status.message &&
      this.status.percent === other.status.percent &&
      this.status.failed === other.status.failed &&
      Boolean(this.status.retry) === Boolean(other.status.retry) &&
      Boolean(this.status.dismiss) === Boolean(other.status.dismiss)
    );
  }
  override updateDOM(dom: HTMLElement): boolean {
    if (widgetIds.get(dom) !== this.id || this.status.failed || dom.classList.contains("failed"))
      return false;
    const message = dom.querySelector('[role="status"]');
    const bar = dom.querySelector("progress");
    if (!message || !bar) return false;
    message.textContent = this.status.message;
    if (this.status.percent === undefined) bar.removeAttribute("value");
    else bar.value = this.status.percent;
    return true;
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("div");
    widgetIds.set(box, this.id);
    box.className = `inline-upload${this.status.failed ? " failed" : ""}`;
    const heading = document.createElement("strong");
    heading.textContent = this.status.filename;
    const message = document.createElement("span");
    message.setAttribute("role", this.status.failed ? "alert" : "status");
    message.textContent = this.status.message;
    box.append(heading, message);
    if (!this.status.failed) {
      const bar = document.createElement("progress");
      bar.max = 100;
      if (this.status.percent !== undefined) bar.value = this.status.percent;
      bar.setAttribute("aria-label", `Adding ${this.status.filename} to notes`);
      box.append(bar);
    }
    for (const [label, action] of [
      ["Retry", this.status.retry],
      ["Dismiss", this.status.dismiss],
    ] as const) {
      if (!action) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = label;
      button.setAttribute("aria-label", `${label} ${this.status.filename}`);
      button.addEventListener("click", action);
      box.append(button);
    }
    return box;
  }
}

const reservations = StateField.define<Map<symbol, Reservation>>({
  create: () => new Map(),
  update(current, transaction) {
    const next = new Map<symbol, Reservation>();
    for (const [id, item] of current) {
      const position = transaction.changes.mapPos(item.position, 1, MapMode.TrackDel);
      if (position !== null) next.set(id, { ...item, position });
    }
    for (const effect of transaction.effects) {
      if (effect.is(reserve)) next.set(effect.value.id, effect.value.reservation);
      if (effect.is(release)) next.delete(effect.value);
      if (effect.is(progress)) {
        const item = next.get(effect.value.id);
        if (item) next.set(effect.value.id, { ...item, status: effect.value.status });
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (items) =>
      Decoration.set(
        [...items.entries()].flatMap(([id, item]) =>
          item.status
            ? [
                Decoration.widget({
                  widget: new UploadWidget(id, item.status),
                  block: true,
                  side: 1,
                }).range(item.position),
              ]
            : [],
        ),
        true,
      ),
    ),
});

export const mediaInsertions: Extension = reservations;

/** Reservations follow edits without persisting temporary upload markers in Markdown. */
export function reserveMediaInsertion(
  editor: EditorView,
  alive: () => boolean,
  atEnd: boolean,
  status?: MediaUploadStatus,
): MediaInsertion {
  const id = Symbol("media insertion");
  editor.dispatch({
    effects: reserve.of({
      id,
      reservation: {
        position: atEnd ? editor.state.doc.length : editor.state.selection.main.to,
        status,
      },
    }),
  });
  return {
    insert: (text) => {
      if (!alive()) return;
      const item = editor.state.field(reservations).get(id);
      if (!item) return;
      const before = editor.state.doc.sliceString(0, item.position);
      const after = editor.state.doc.sliceString(item.position);
      editor.dispatch({
        changes: {
          from: item.position,
          insert: `${before && !before.endsWith("\n\n") ? "\n\n" : ""}${text}${after && !after.startsWith("\n\n") ? "\n\n" : ""}`,
        },
        effects: release.of(id),
      });
    },
    cancel: () => {
      if (alive()) editor.dispatch({ effects: release.of(id) });
    },
    update: (status) => {
      if (alive()) editor.dispatch({ effects: progress.of({ id, status }) });
    },
  };
}
