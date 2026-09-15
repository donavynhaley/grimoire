// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../src/components/MarkdownEditor";

afterEach(cleanup);

async function editor() {
  const ref = createRef<MarkdownEditorHandle>();
  const onChange = vi.fn();
  const rendered = render(
    <MarkdownEditor
      ref={ref}
      ariaLabel="Notes"
      value="Before. After."
      onChange={onChange}
      placeholder="Notes"
    />,
  );
  const surface = await screen.findByRole("textbox", { name: "Notes" });
  const view = EditorView.findFromDOM(surface)!;
  act(() => ref.current!.focus(7));
  return { ref, view, onChange, ...rendered };
}

it("reserving an upload position never writes a pending marker into the saved notes", async () => {
  const { ref, onChange, view } = await editor();
  act(() => ref.current!.reserveInsertion());
  expect(view.state.doc.toString()).toBe("Before. After.");
  expect(onChange).not.toHaveBeenCalled();
});

it("deleting the reserved position prevents a late upload from restoring removed content", async () => {
  const { ref, view } = await editor();
  let insertion!: ReturnType<MarkdownEditorHandle["reserveInsertion"]>;
  act(() => {
    insertion = ref.current!.reserveInsertion();
  });
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Replacement." } }));
  act(() => insertion.insert('![Recording](/private "video/mp4")'));
  expect(view.state.doc.toString()).toBe("Replacement.");
});

it("dismissed and unmounted uploads cannot insert media later", async () => {
  const { ref, view, onChange, unmount } = await editor();
  let insertion!: ReturnType<MarkdownEditorHandle["reserveInsertion"]>;
  act(() => {
    insertion = ref.current!.reserveInsertion();
    insertion.cancel();
    insertion.insert("media");
  });
  expect(view.state.doc.toString()).toBe("Before. After.");
  act(() => {
    insertion = ref.current!.reserveInsertion();
  });
  unmount();
  insertion.insert("media");
  expect(onChange).not.toHaveBeenCalled();
});
