import { type ChangeEvent, useState } from "react";
import type { ImportPlan, ImportSource } from "../../shared/types";
import { PAGE_STATUS_LABELS } from "../../shared/types";
import { ApiError, importBoard } from "../api/client";
import { Growing } from "./Growing";

const COLUMN_CHOICES = Object.values(PAGE_STATUS_LABELS);

/** One name the export carries that still needs a column: a Trello list or a status option. */
type MappingRow = { kind: "list" | "option"; name: string; cards: number; column: string | null };

/**
 * Upload another tool's export, watch what it would create, answer what the synonym table
 * could not, apply. The server's plan is the truth on every step: each choice re-plans and
 * the screen renders what came back, so what the button says it will import is what lands.
 * Success needs no reload button - the apply's broadcast reaches this browser too, and the
 * board behind the dialog refreshes through the same live event everyone else gets.
 */
export function ImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<ImportSource>("trello");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [board, setBoard] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState<number | null>(null);
  // Which how-to-export guide is unfolded; one at a time, because they answer one question.
  const [guide, setGuide] = useState<ImportSource | null>(null);

  const replan = async (input: {
    file: File;
    source: ImportSource;
    rows: MappingRow[];
    board: string | null;
    status: string | null;
    apply?: boolean;
  }) => {
    setBusy(true);
    setError("");
    try {
      const mappings = (kind: MappingRow["kind"]) =>
        Object.fromEntries(
          input.rows
            .filter((row) => row.kind === kind && row.column)
            .map((row) => [row.name, row.column as string]),
        );
      const result = await importBoard(input.file, input.source, {
        lists: mappings("list"),
        options: mappings("option"),
        board: input.board,
        status: input.status,
        apply: input.apply,
      });
      if (result.applied !== null) {
        setApplied(result.applied);
        setPlan(null);
        setRows([]);
        return;
      }
      setPlan(result.plan);
      // Rows accumulate rather than mirror the plan: a mapped name leaves the plan's
      // unmapped set, but its select stays, so a choice can be revisited.
      setRows((current) => {
        const known = new Set(current.map((row) => `${row.kind}:${row.name}`));
        const fresh: MappingRow[] = [
          ...result.plan.unmappedLists.map((list) => ({
            kind: "list" as const,
            name: list.name,
            cards: list.cards,
            column: null,
          })),
          ...result.plan.unmappedOptions.map((option) => ({
            kind: "option" as const,
            name: option.value,
            cards: option.cards,
            column: null,
          })),
        ].filter((row) => !known.has(`${row.kind}:${row.name}`));
        return [...current, ...fresh];
      });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "The import could not be read");
    } finally {
      setBusy(false);
    }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    if (!chosen) return;
    const detected: ImportSource =
      chosen.name.endsWith(".boardarchive") || chosen.name.endsWith(".jsonl") ? "focalboard" : "trello";
    setFile(chosen);
    setSource(detected);
    setPlan(null);
    setRows([]);
    setBoard(null);
    setStatus(null);
    setApplied(null);
    void replan({ file: chosen, source: detected, rows: [], board: null, status: null });
  };

  const setColumn = (target: MappingRow, column: string) => {
    if (!file) return;
    const next = rows.map((row) => (row === target ? { ...row, column } : row));
    setRows(next);
    void replan({ file, source, rows: next, board, status });
  };

  const chooseBoard = (value: string) => {
    if (!file) return;
    setBoard(value);
    void replan({ file, source, rows, board: value, status });
  };

  const chooseStatus = (value: string) => {
    if (!file) return;
    setStatus(value);
    void replan({ file, source, rows, board, status: value });
  };

  const unresolved = rows.some((row) => !row.column);
  const ready =
    plan !== null &&
    !busy &&
    !unresolved &&
    plan.errors.length === 0 &&
    plan.boards === null &&
    plan.statusChoices === null &&
    plan.toCreate.length > 0;

  const columnCounts =
    plan === null
      ? []
      : Object.entries(PAGE_STATUS_LABELS)
          .map(([pageStatus, pageLabel]) => ({
            label: pageLabel,
            count: plan.toCreate.filter((page) => page.status === pageStatus).length,
          }))
          .filter((entry) => entry.count > 0);

  return (
    <Growing className="settings-section">
      <p className="settings-summary">
        Bring a board over whole, from the file its own tool exports. Nothing is written until the plan below
        says what will land where and you say go; running it twice never duplicates a card.
      </p>

      <ul className="import-guides">
        <li>
          <Growing className="import-guide">
            <button
              aria-expanded={guide === "trello"}
              className="import-guide-toggle"
              onClick={() => setGuide(guide === "trello" ? null : "trello")}
              type="button"
            >
              Coming from Trello
            </button>
            {guide === "trello" && (
              <ol className="import-guide-steps">
                <li>Open your board in Trello.</li>
                <li>
                  Open the board menu - the ... at the board's top right - and choose Print, export, and
                  share.
                </li>
                <li>Choose Export as JSON and save the file. Free workspaces have it too.</li>
                <li>Choose that .json file below. Lists Grimoire cannot place get a column dropdown here.</li>
              </ol>
            )}
          </Growing>
        </li>
        <li>
          <Growing className="import-guide">
            <button
              aria-expanded={guide === "focalboard"}
              className="import-guide-toggle"
              onClick={() => setGuide(guide === "focalboard" ? null : "focalboard")}
              type="button"
            >
              Coming from Focalboard
            </button>
            {guide === "focalboard" && (
              <ol className="import-guide-steps">
                <li>Open your board in Focalboard.</li>
                <li>
                  Open the board's options menu - the ... beside its name - and choose Export board archive.
                </li>
                <li>Save the .boardarchive file, and leave it zipped: Grimoire reads it as it is.</li>
                <li>
                  Choose that file below. Statuses Grimoire cannot place get a column dropdown here, and an
                  archive holding several boards gets a board picker.
                </li>
              </ol>
            )}
          </Growing>
        </li>
      </ul>

      <div className="settings-input import-file">
        <label className="field-label" htmlFor="import-file">
          Export file
        </label>
        <input accept=".json,.boardarchive,.jsonl" id="import-file" onChange={choose} type="file" />
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {plan?.boards && file && (
        <div className="settings-input">
          <label className="field-label" htmlFor="import-board">
            The archive holds several boards - which one?
          </label>
          <select id="import-board" onChange={(event) => chooseBoard(event.target.value)} value={board ?? ""}>
            <option disabled value="">
              choose a board
            </option>
            {plan.boards.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {plan?.statusChoices && file && (
        <div className="settings-input">
          <label className="field-label" htmlFor="import-status">
            Which property holds the board's columns?
          </label>
          <select
            id="import-status"
            onChange={(event) => chooseStatus(event.target.value)}
            value={status ?? ""}
          >
            <option disabled value="">
              choose a property
            </option>
            {plan.statusChoices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      )}

      {rows.length > 0 && (
        <div className="import-mappings">
          <p className="field-label">These need a column before anything imports</p>
          <ul className="import-mapping-list">
            {rows.map((row) => (
              <li className="import-mapping-row" key={`${row.kind}:${row.name}`}>
                <span className="import-mapping-name">
                  {row.name}
                  <span className="import-mapping-count">
                    {row.cards} card{row.cards === 1 ? "" : "s"}
                  </span>
                </span>
                <select
                  aria-label={`Column for ${row.name}`}
                  onChange={(event) => setColumn(row, event.target.value)}
                  value={row.column ?? ""}
                >
                  <option disabled value="">
                    choose a column
                  </option>
                  {COLUMN_CHOICES.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan && (
        <div className="import-plan">
          <p className="settings-summary">
            {plan.toCreate.length} of {plan.total} card{plan.total === 1 ? "" : "s"} import
            {columnCounts.length > 0 &&
              `: ${columnCounts.map((entry) => `${entry.count} to ${entry.label}`).join(", ")}`}
            {plan.skipped.length > 0 && ` · ${plan.skipped.length} stay behind`}
          </p>
          {plan.warnings.length > 0 && (
            <ul className="import-warnings">
              {plan.warnings.slice(0, 6).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {plan.warnings.length > 6 && <li>and {plan.warnings.length - 6} more</li>}
            </ul>
          )}
          <button
            className="primary-button compact"
            disabled={!ready}
            onClick={() => file && void replan({ file, source, rows, board, status, apply: true })}
            type="button"
          >
            {busy
              ? "working…"
              : `Import ${plan.toCreate.length} page${plan.toCreate.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {applied !== null && (
        <p className="saved-note" role="status">
          Imported {applied} page{applied === 1 ? "" : "s"}.
        </p>
      )}
    </Growing>
  );
}
