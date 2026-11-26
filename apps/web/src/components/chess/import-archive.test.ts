import { createMatch, MAX_ARCHIVE_BYTES } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import {
  type ArchiveCheck,
  checkArchiveFile,
  IMPORT_INITIAL,
  type ImportAction,
  type ImportState,
  importReducer,
  landLatest,
  pasteToggle,
  readThenClear,
} from "./import-archive";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
// A finished game: the starting position is already checkmate.
const finished = () =>
  createMatch({
    title: "Finished import",
    white: player,
    black: player,
    rules: {},
    initialFen: "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
  });

const file = (text: string, size = new TextEncoder().encode(text).length) => ({
  size,
  text: async () => text,
});

describe("checkArchiveFile", () => {
  it("accepts a finished archive and keeps its exact text for the request", async () => {
    const text = JSON.stringify(finished(), null, 2);
    const check = await checkArchiveFile(file(text));
    expect(check.kind).toBe("ok");
    if (check.kind === "ok") {
      expect(check.json).toBe(text);
      expect(check.game.config.title).toBe("Finished import");
    }
  });
  it("refuses a file over the 2 MB interchange limit without reading it", async () => {
    let read = false;
    const check = await checkArchiveFile({
      size: MAX_ARCHIVE_BYTES + 1,
      text: async () => {
        read = true;
        return "";
      },
    });
    expect(check.kind).toBe("too-large");
    expect(read).toBe(false);
  });
  it("treats a file that can no longer be read as invalid, not as a crash", async () => {
    const check = await checkArchiveFile({
      size: 10,
      text: () => Promise.reject(new DOMException("gone", "NotFoundError")),
    });
    expect(check.kind).toBe("invalid");
  });
  it("calls anything that is not a valid archive invalid", async () => {
    expect((await checkArchiveFile(file("not json"))).kind).toBe("invalid");
    expect((await checkArchiveFile(file('{"id":"x"}'))).kind).toBe("invalid");
  });
  it("names a still-running game so the dialog can say to stop it first", async () => {
    const running = createMatch({ white: player, black: player, rules: {} });
    expect(running.status).toBe("running");
    const check = await checkArchiveFile(file(JSON.stringify(running)));
    expect(check.kind).toBe("running");
  });
});

describe("importReducer", () => {
  const game = finished();
  const ok = { kind: "ok" as const, game, json: "{}" };
  const start = (generation: number, name = `f${generation}.json`) =>
    ({ type: "read-start", generation, name, size: 10 }) as const;

  it("shows the latest choice even when an older read finishes last", () => {
    let state = importReducer(IMPORT_INITIAL, start(1, "old.json"));
    state = importReducer(state, start(2, "new.json"));
    state = importReducer(state, { type: "read-done", generation: 2, check: { kind: "invalid" } });
    state = importReducer(state, { type: "read-done", generation: 1, check: ok });
    expect(state.chosen?.name).toBe("new.json");
    expect(state.chosen?.game).toBeNull();
    expect(state.problem).toBe("invalid");
    expect(state.reading).toBe(false);
  });
  it("ignores a read that finishes after the dialog was closed", () => {
    let state = importReducer(IMPORT_INITIAL, start(1));
    state = importReducer(state, { type: "reset", generation: 2 });
    state = importReducer(state, { type: "read-done", generation: 1, check: ok });
    expect(state).toEqual({ ...IMPORT_INITIAL, generation: 2 });
  });
  it("keeps paste and file apart, so a preview never describes other JSON", () => {
    let state = importReducer(IMPORT_INITIAL, start(1));
    state = importReducer(state, { type: "read-done", generation: 1, check: ok });
    expect(state.chosen?.game).toBe(game);
    state = importReducer(state, { type: "paste", open: true, generation: 2 });
    expect(state).toMatchObject({ chosen: null, problem: null, pasteOpen: true });
    // A read started before the paste box opened cannot bring the file back.
    state = importReducer(state, { type: "read-done", generation: 1, check: ok });
    expect(state.chosen).toBeNull();
    // Choosing a file closes the paste box.
    state = importReducer(state, start(3));
    expect(state.pasteOpen).toBe(false);
  });
  it("names a running game and a too-large file as problems", () => {
    let state = importReducer(IMPORT_INITIAL, start(1));
    state = importReducer(state, {
      type: "read-done",
      generation: 1,
      check: { kind: "running", game },
    });
    expect(state.problem).toBe("running");
    expect(state.chosen?.game).toBe(game);
    state = importReducer(state, start(2));
    state = importReducer(state, {
      type: "read-done",
      generation: 2,
      check: { kind: "too-large" },
    });
    expect(state.problem).toBe("too-large");
  });
});

describe("readThenClear", () => {
  const fileA = { name: "a.json" } as File;
  const fileB = { name: "b.json" } as File;
  const deferred = () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  it("reads before clearing, so the file is still there while it is read", async () => {
    const input = { files: [fileA], value: "C:\\fakepath\\a.json" };
    let seen: string | undefined;
    await readThenClear(input, async (file) => {
      seen = file?.name;
      expect(input.value).not.toBe("");
    });
    expect(seen).toBe("a.json");
    expect(input.value).toBe("");
  });
  it("never lets an older read clear a newer choice", async () => {
    const input = { files: [fileA] as File[], value: "a" };
    const slowA = deferred();
    const readA = readThenClear(input, () => slowA.promise);
    // The user picks B while A is still being read.
    input.files = [fileB];
    input.value = "b";
    const slowB = deferred();
    const readB = readThenClear(input, () => slowB.promise);
    slowA.resolve();
    await readA;
    expect(input.value).toBe("b");
    slowB.resolve();
    await readB;
    expect(input.value).toBe("");
  });
  it("clears even when the read fails", async () => {
    const input = { files: [fileA], value: "a" };
    await expect(
      readThenClear(input, () => Promise.reject(new Error("unreadable"))),
    ).rejects.toThrow("unreadable");
    expect(input.value).toBe("");
  });
});

describe("pasteToggle", () => {
  const withFile = { pasteOpen: false, chosen: { name: "a.json", size: 1, game: null } };
  it("drops a chosen file's JSON when the paste box opens", () => {
    expect(pasteToggle(withFile, true, false)).toEqual({ apply: true, clearJson: true });
  });
  it("keeps text pasted earlier when the box is closed and reopened", () => {
    expect(pasteToggle({ pasteOpen: true, chosen: null }, false, false)).toEqual({
      apply: true,
      clearJson: false,
    });
    expect(pasteToggle({ pasteOpen: false, chosen: null }, true, false)).toEqual({
      apply: true,
      clearJson: false,
    });
  });
  it("does nothing while an import is in flight, or when nothing changes", () => {
    expect(pasteToggle(withFile, true, true)).toEqual({ apply: false, clearJson: false });
    expect(pasteToggle(withFile, false, false)).toEqual({ apply: false, clearJson: false });
  });
});

describe("landLatest with the import dialog's state", () => {
  // The dialog's wiring: a reads counter, the reducer, and the form's JSON value.
  function dialog() {
    const reads = { current: 0 };
    let state: ImportState = IMPORT_INITIAL;
    let json = "";
    const dispatch = (action: ImportAction) => {
      state = importReducer(state, action);
    };
    const choose = (name: string, check: Promise<ArchiveCheck>) =>
      landLatest(
        reads,
        () => check,
        (result, generation) => {
          dispatch({ type: "read-done", generation, check: result });
          json = result.kind === "ok" ? result.json : "";
        },
        (generation) => dispatch({ type: "read-start", generation, name, size: 1 }),
      );
    return {
      reads,
      dispatch,
      choose,
      get state() {
        return state;
      },
      get json() {
        return json;
      },
    };
  }
  const later = <T>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const okFor = (title: string): ArchiveCheck => {
    const game = { ...finished(), config: { ...finished().config, title } };
    return { kind: "ok", game, json: title };
  };

  it("lands only the latest of two overlapping choices, in preview and JSON alike", async () => {
    const d = dialog();
    const a = later<ArchiveCheck>();
    const b = later<ArchiveCheck>();
    const readA = d.choose("a.json", a.promise);
    const readB = d.choose("b.json", b.promise);
    b.resolve(okFor("B"));
    await readB;
    a.resolve(okFor("A"));
    await readA;
    expect(d.state.chosen?.name).toBe("b.json");
    expect(d.state.chosen?.game?.config.title).toBe("B");
    expect(d.json).toBe("B");
  });
  it("drops a read that finishes after the dialog closed", async () => {
    const d = dialog();
    const a = later<ArchiveCheck>();
    const readA = d.choose("a.json", a.promise);
    d.reads.current += 1;
    d.dispatch({ type: "reset", generation: d.reads.current });
    a.resolve(okFor("A"));
    await readA;
    expect(d.state.chosen).toBeNull();
    expect(d.json).toBe("");
  });
  it("drops a read that finishes after the paste box opened", async () => {
    const d = dialog();
    const a = later<ArchiveCheck>();
    const readA = d.choose("a.json", a.promise);
    expect(pasteToggle(d.state, true, false).apply).toBe(true);
    d.reads.current += 1;
    d.dispatch({ type: "paste", open: true, generation: d.reads.current });
    a.resolve(okFor("A"));
    await readA;
    expect(d.state).toMatchObject({ chosen: null, pasteOpen: true });
    expect(d.json).toBe("");
  });
});
