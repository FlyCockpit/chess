import { MAX_ARCHIVE_BYTES, type MatchArchive, validateArchive } from "@cockpit-chess/chess";

/**
 * What Studio's import dialog makes of a chosen file before anything is sent: the game it
 * holds (replayed and checked, the same validation the server repeats), or why it cannot be
 * imported. Only an `ok` result fills the request.
 */
export type ArchiveCheck =
  | { kind: "ok"; game: MatchArchive; json: string }
  | { kind: "too-large" }
  | { kind: "invalid" }
  | { kind: "unsupported" }
  | { kind: "running"; game: MatchArchive };

export async function checkArchiveFile(file: Pick<File, "size" | "text">): Promise<ArchiveCheck> {
  if (file.size > MAX_ARCHIVE_BYTES) return { kind: "too-large" };
  let json: string;
  let game: MatchArchive;
  let parsed: unknown;
  try {
    // A file that cannot be read (moved or deleted since it was chosen) is not importable either.
    json = await file.text();
    parsed = JSON.parse(json);
    game = validateArchive(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unsupported ") &&
      typeof parsed === "object" &&
      parsed !== null &&
      "format" in parsed
    )
      return { kind: "unsupported" };
    return { kind: "invalid" };
  }
  return game.status === "running" ? { kind: "running", game } : { kind: "ok", game, json };
}

/**
 * A chosen file's size in the reader's locale: whole bytes under 1 kB ("34 bytes", not
 * "0 kB"), then kB, then MB (decimal units, like MAX_ARCHIVE_BYTES).
 */
export function formatFileSize(bytes: number, locale: string): string {
  const [unit, value, unitDisplay] =
    bytes < 1000
      ? (["byte", bytes, "long"] as const)
      : bytes < 1_000_000
        ? (["kilobyte", bytes / 1000, "short"] as const)
        : (["megabyte", bytes / 1_000_000, "short"] as const);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay,
    maximumFractionDigits: 1,
  }).format(value);
}

/** The dialog's view of the chosen file. `generation` ties a finished read to the latest choice. */
export type ImportState = {
  generation: number;
  reading: boolean;
  chosen: { name: string; size: number; game: MatchArchive | null } | null;
  problem: Exclude<ArchiveCheck["kind"], "ok"> | null;
  pasteOpen: boolean;
};
export type ImportAction =
  | { type: "read-start"; generation: number; name: string; size: number }
  | { type: "read-done"; generation: number; check: ArchiveCheck }
  | { type: "paste"; open: boolean; generation: number }
  | { type: "reset"; generation: number };

export const IMPORT_INITIAL: ImportState = {
  generation: 0,
  reading: false,
  chosen: null,
  problem: null,
  pasteOpen: false,
};

/**
 * A file choice and the paste box are alternatives: choosing a file closes the paste box,
 * opening the paste box drops the file (so a preview never describes other JSON). A read that
 * finishes after a newer choice, a paste or a close (a newer generation) is ignored.
 */
export function importReducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case "read-start":
      return {
        generation: action.generation,
        reading: true,
        chosen: { name: action.name, size: action.size, game: null },
        problem: null,
        pasteOpen: false,
      };
    case "read-done": {
      if (action.generation !== state.generation || !state.chosen) return state;
      const { check } = action;
      return {
        ...state,
        reading: false,
        chosen: {
          ...state.chosen,
          game: check.kind === "ok" || check.kind === "running" ? check.game : null,
        },
        problem: check.kind === "ok" ? null : check.kind,
      };
    }
    case "paste":
      return action.open
        ? { ...IMPORT_INITIAL, generation: action.generation, pasteOpen: true }
        : { ...state, pasteOpen: false };
    case "reset":
      return { ...IMPORT_INITIAL, generation: action.generation };
  }
}

/**
 * Reads the input's chosen file, then clears the input so choosing the same file again fires
 * `change`. Clearing waits for the read (clearing first can invalidate the file) and skips an
 * input that already holds a newer choice.
 */
export async function readThenClear(
  input: { files: ArrayLike<File> | null; value: string },
  read: (file: File | undefined) => Promise<unknown>,
) {
  const file = input.files?.[0];
  try {
    await read(file);
  } finally {
    if (input.files?.[0] === file) input.value = "";
  }
}

/** What opening or closing the paste box does: ignored while importing; drops a chosen file. */
export function pasteToggle(
  state: Pick<ImportState, "pasteOpen" | "chosen">,
  open: boolean,
  busy: boolean,
) {
  if (open === state.pasteOpen || busy) return { apply: false, clearJson: false };
  return { apply: true, clearJson: open && state.chosen !== null };
}

/**
 * Runs one file read so that only the latest lands: `start` runs at once with this read's
 * generation, `apply` only if no newer read, paste or close (anything that bumps
 * `reads.current`) happened meanwhile. Shared by Studio's import dialog and the public lab.
 */
export async function landLatest<T>(
  reads: { current: number },
  work: () => Promise<T>,
  apply: (result: T, generation: number) => void,
  start?: (generation: number) => void,
) {
  reads.current += 1;
  const generation = reads.current;
  start?.(generation);
  const result = await work();
  if (generation === reads.current) apply(result, generation);
}
