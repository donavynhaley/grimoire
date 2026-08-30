import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  Chapter,
  Member,
  PageCategory,
  PageStatus,
  ProjectCategory,
  ProjectField,
} from "../../shared/types";
import {
  type CaptureSettings,
  filterOptions,
  type PickerKind,
  type PickerOption,
  type PickerState,
  parseWritten,
  pickerOptions,
  picksFromList,
} from "../lib/capture-pickers";

type Options = {
  categories: ProjectCategory[];
  chapters: Chapter[];
  /** The project's own fields; the "!" command and the field chips open these. */
  fields: ProjectField[];
  members: Member[];
  settings: CaptureSettings;
  /** The same settings, current one render early — see `setWrittenField`. */
  settingsRef: RefObject<CaptureSettings>;
  setSettings: Dispatch<SetStateAction<CaptureSettings>>;
  setTitle: Dispatch<SetStateAction<string>>;
  /** The title input, where focus returns whenever a choice hands typing back to it. */
  inputRef: RefObject<HTMLInputElement | null>;
};

export type CapturePickerControl = {
  picker: PickerState | null;
  setPicker: Dispatch<SetStateAction<PickerState | null>>;
  highlighted: number;
  setHighlighted: Dispatch<SetStateAction<number>>;
  options: PickerOption[];
  visibleOptions: PickerOption[];
  /** The field the open panel belongs to, when it is one of the project's own. */
  openField: ProjectField | null;
  /** The open field again, when it is written in rather than picked from a list. */
  writingField: ProjectField | null;
  /** What has been typed into a written field's panel, before it is set. */
  fieldDraft: string;
  setFieldDraft: Dispatch<SetStateAction<string>>;
  openPicker: (kind: PickerKind, fieldKey?: string) => void;
  setWrittenField: (options: { refocus: boolean }) => void;
  choose: (option: PickerOption) => void;
  steerPicker: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * The capture bar's picker: which one is open, what it offers, where the keyboard is in it,
 * and how a choice lands in the capture's settings.
 */
export function useCapturePicker({
  categories,
  chapters,
  fields,
  members,
  settings,
  settingsRef,
  setSettings,
  setTitle,
  inputRef,
}: Options): CapturePickerControl {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  /** What has been typed into a written field's panel, before it is set. */
  const [fieldDraft, setFieldDraft] = useState("");
  const options = useMemo(
    () => pickerOptions(picker, categories, chapters, members, fields),
    [categories, chapters, fields, members, picker],
  );
  const visibleOptions = useMemo(() => filterOptions(options, picker?.query ?? ""), [options, picker?.query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the picker's kind and query are the triggers for putting the highlight back to the top, not values the effect reads
  useEffect(() => {
    setHighlighted(0);
  }, [picker?.kind, picker?.query]);

  const openPicker = (kind: PickerKind, fieldKey?: string) => {
    setPicker({ kind, fieldKey, query: "", commandStart: null });
    setHighlighted(0);
    // A written field's panel opens holding what it already has, ready to be corrected.
    const held = fieldKey ? settings.fields[fieldKey] : undefined;
    setFieldDraft(held === undefined ? "" : String(held));
  };

  /** The field the open panel belongs to, when it is one of the project's own. */
  const openField =
    picker?.kind === "field" ? (fields.find((candidate) => candidate.key === picker.fieldKey) ?? null) : null;
  const writingField = openField && !picksFromList(openField) ? openField : null;

  /**
   * Commits whatever the panel holds; an empty or unparseable value clears the field.
   *
   * Written through the ref as well as state, because the commit often runs from a blur
   * whose very next event - the tap that caused it - may be the submit itself, one render
   * before state catches up.
   */
  const setWrittenField = ({ refocus }: { refocus: boolean }) => {
    if (!writingField) return;
    const parsed = parseWritten(writingField, fieldDraft);
    const nextFields = { ...settingsRef.current.fields };
    if (parsed === null) delete nextFields[writingField.key];
    else nextFields[writingField.key] = parsed;
    settingsRef.current = { ...settingsRef.current, fields: nextFields };
    setSettings(settingsRef.current);
    setPicker(null);
    // Enter means "done, back to the title"; a tap-away already chose where focus goes.
    if (refocus) inputRef.current?.focus();
  };

  const choose = (option: PickerOption) => {
    if (!picker) return;
    if (picker.kind === "field-cmd" && option.fieldKey) {
      // The field's own picker takes over, exactly as if its chip had been tapped, and
      // the command text leaves the title on the way.
      if (picker.commandStart !== null) {
        const consumed = picker.commandStart;
        setTitle((current) => {
          const kept = current.slice(0, consumed).trimEnd();
          return kept ? `${kept} ` : "";
        });
      }
      openPicker("field", option.fieldKey);
      return;
    }
    setSettings((current) => {
      if (picker.kind === "category") return { ...current, category: option.value as PageCategory | null };
      if (picker.kind === "chapter") return { ...current, chapter: option.value as string | null };
      if (picker.kind === "assignee") return { ...current, assigneeId: option.value as string | null };
      if (picker.kind === "field" && picker.fieldKey) {
        // Choosing "not set" removes the key entirely, so the created page never carries it.
        const next = { ...current.fields };
        if (option.value === null) delete next[picker.fieldKey];
        else next[picker.fieldKey] = option.value;
        return { ...current, fields: next };
      }
      return { ...current, status: (option.value ?? "backlog") as PageStatus };
    });
    if (picker.commandStart !== null) {
      // Keep one trailing space so the next trigger char still follows
      // whitespace — commandAtEnd only fires after whitespace, and without
      // this a second command can't be typed until a space is added by hand.
      setTitle((current) => {
        const kept = current.slice(0, picker.commandStart!).trimEnd();
        return kept ? `${kept} ` : "";
      });
    }
    setPicker(null);
    inputRef.current?.focus();
  };

  const steerPicker = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!picker) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleOptions.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + direction + visibleOptions.length) % visibleOptions.length);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && visibleOptions.length > 0) {
      event.preventDefault();
      choose(visibleOptions[Math.min(highlighted, visibleOptions.length - 1)]!);
    }
  };

  return {
    picker,
    setPicker,
    highlighted,
    setHighlighted,
    options,
    visibleOptions,
    openField,
    writingField,
    fieldDraft,
    setFieldDraft,
    openPicker,
    setWrittenField,
    choose,
    steerPicker,
  };
}
