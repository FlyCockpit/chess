import {
  Chess,
  createMatch,
  legalMoves,
  type MatchArchive,
  submitMove,
  validateArchive,
} from "@cockpit-chess/chess";
import { gamePositions } from "@cockpit-chess/chess/spectator";
import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { ILLEGAL_MS } from "../board-motion";
import { checkArchiveFile } from "../import-archive";
import { videoFixtureGame, videoIllegalFixtureGame } from "./video-fixture";
import {
  AUTO_MAX_SECONDS_PER_MOVE,
  buildVideoPlan,
  cleanRemark,
  defaultVideoOptions,
  FINAL_HOLD_SECONDS,
  FLASH_FRAMES,
  ILLEGAL_HOLD_SECONDS,
  LOOKUP_SECONDS,
  pacing,
  STILL_ATTEMPT_SECONDS,
  TITLE_SECONDS,
  VIDEO_FPS,
  type VideoOptions,
  videoFeatures,
  videoFileName,
  X_MAX_SECONDS,
} from "./video-plan";

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { chess: chessEn } },
  interpolation: { escapeValue: false },
});
const t = i18n.getFixedT("en", "chess") as unknown as (
  key: string,
  params?: Record<string, string | number>,
) => string;

function plainMatch(moves: string[], rules: Record<string, unknown> = {}) {
  const match = createMatch(
    {
      title: "Plain",
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules,
    },
    "hosted",
  );
  const chess = new Chess(match.config.initialFen);
  for (const move of moves) submitMove(match, chess, move);
  return match;
}

const all: VideoOptions = {
  aspect: "square",
  pace: "auto",
  evalBar: true,
  remarks: true,
  clocks: true,
  illegal: false,
  lookups: false,
};

function seconds(positions: number, remarks: number, pace: VideoOptions["pace"]) {
  const { perMove, remarkExtra } = pacing(positions, remarks, pace);
  return (
    TITLE_SECONDS + FINAL_HOLD_SECONDS + (positions * perMove + remarks * remarkExtra) / VIDEO_FPS
  );
}

describe("pacing", () => {
  it.each([1, 2, 10, 40, 80, 134, 200, 300, 601])(
    "auto fits %i positions inside X's 2:20, remarks or not",
    (positions) => {
      for (const remarks of [0, Math.floor(positions / 2), positions]) {
        expect(seconds(positions, remarks, "auto")).toBeLessThanOrEqual(X_MAX_SECONDS);
      }
    },
  );

  it("is about 0.6–1.5 s per move, faster for long games", () => {
    const short = pacing(20, 0, "auto").perMove / VIDEO_FPS;
    const medium = pacing(160, 0, "auto").perMove / VIDEO_FPS;
    const long = pacing(220, 0, "auto").perMove / VIDEO_FPS;
    expect(short).toBe(AUTO_MAX_SECONDS_PER_MOVE);
    expect(medium).toBeLessThan(short);
    expect(medium).toBeGreaterThanOrEqual(0.6);
    expect(long).toBeGreaterThanOrEqual(0.6);
    expect(pacing(601, 0, "auto").perMove).toBeGreaterThanOrEqual(1);
  });

  it("gives remark moves reading time from the spare budget only", () => {
    expect(pacing(20, 5, "auto").remarkExtra).toBe(30);
    expect(pacing(250, 50, "auto").remarkExtra).toBe(0);
  });

  it("takes a fixed pace literally", () => {
    expect(pacing(10, 0, "0.5").perMove).toBe(15);
    expect(pacing(10, 0, "2").perMove).toBe(60);
    // Every position, remark or not, lasts exactly the chosen time.
    expect(pacing(10, 2, "1").remarkExtra).toBe(0);
    expect(pacing(10, 2, "3").remarkExtra).toBe(0);
    expect(seconds(200, 0, "3")).toBeGreaterThan(X_MAX_SECONDS);
  });
});

describe("options", () => {
  it("defaults to square, auto pace and every feature the match has", () => {
    expect(defaultVideoOptions(videoFixtureGame())).toEqual(all);
  });

  it("turns off what the match does not have", () => {
    const match = plainMatch(["e2e4", "e7e5"]);
    expect(videoFeatures(match)).toEqual({
      evalBar: false,
      remarks: false,
      clocks: false,
      illegal: false,
      lookups: false,
    });
    expect(defaultVideoOptions(match)).toEqual({
      aspect: "square",
      pace: "auto",
      evalBar: false,
      remarks: false,
      clocks: false,
      illegal: false,
      lookups: false,
    });
  });
});

describe("frame plan", () => {
  const match = videoFixtureGame();
  const plan = buildVideoPlan(match, all, t);
  const states = plan.scenes.map((scene) => scene.state);

  it("includes a reply cap in the title only when set", () => {
    expect(states[0]?.titleCard?.rules).not.toMatch(/reply cap/i);
    const capped = structuredClone(match);
    capped.config.rules = { ...capped.config.rules, maxOutputTokens: 64 };
    expect(buildVideoPlan(capped, all, t).scenes[0]?.state.titleCard?.rules).toContain(
      "Reply cap 64 tokens",
    );
  });
  it("is a title card, every position in order, then the final hold", () => {
    expect(states.map((s) => s.kind)).toEqual(["title", ...Array(8).fill("position"), "final"]);
    expect(states.map((s) => s.moveLabel)).toEqual([
      null,
      null,
      "1. e4",
      "1... e5",
      "2. Bc4",
      "2... Nc6",
      "3. Qh5",
      "3... Nf6",
      "4. Qxf7#",
      "4. Qxf7#",
    ]);
    expect(states[8]?.lastMove).toBe("h5f7");
    expect(plan.scenes[0]?.frames).toBe(TITLE_SECONDS * VIDEO_FPS);
    expect(plan.scenes.at(-1)?.frames).toBe(FINAL_HOLD_SECONDS * VIDEO_FPS);
    expect(plan.totalFrames).toBe(plan.scenes.reduce((n, s) => n + s.frames, 0));
    expect(plan.totalFrames / VIDEO_FPS).toBeLessThanOrEqual(X_MAX_SECONDS);
    expect(plan).toMatchObject({ width: 1080, height: 1080, fps: 30 });
  });

  it("puts each remark on its own move, as cleaned plain text", () => {
    expect(states.map((s) => s.remark?.text ?? null)).toEqual([
      null,
      null,
      "Center first. <b>Obviously</b>.",
      null,
      "Your king looks nervous.",
      null,
      "Hello from h5!",
      "I see no danger here at all.",
      "Checkmate. Good game.",
      null,
    ]);
    expect(states[2]?.remark).toMatchObject({ side: "w", speaker: "White · GPT-4.1 Nano" });
    expect(states[7]?.remark).toMatchObject({ side: "b", speaker: "Black · GPT-4.1 Mini" });
    // Remark moves hold longer than plain moves.
    expect(plan.scenes[2]?.frames).toBeGreaterThan(plan.scenes[3]?.frames ?? 0);
  });

  it("shows the evaluation of the position reached, and the clocks", () => {
    expect(states[1]?.evaluation).toBeNull();
    expect(states[2]?.evaluation?.label).toBe("+0.3");
    expect(states[7]?.evaluation?.label).toBe("M1");
    expect(states[7]?.evaluation?.share).toBe(1);
    // The mating move has no engine evaluation, but the board is mate.
    expect(states[8]?.evaluation).toEqual({ share: 1, label: "#" });
    expect(states[9]?.evaluation).toEqual({ share: 1, label: "#" });
    expect(states[1]?.players).toEqual({
      w: { label: "White · GPT-4.1 Nano", clock: "2:00" },
      b: { label: "Black · GPT-4.1 Mini", clock: "2:00" },
    });
    expect(states[2]?.players.w.clock).toBe("1:56");
    expect(states[3]?.players.b.clock).toBe("1:56");
    expect(states[2]?.toMove).toBe("b");
    expect(states[9]?.toMove).toBeNull();
  });

  it("ends on the result banner", () => {
    // The same plain-words ending as the game view; the result as its detail.
    expect(states[9]?.banner).toEqual({ headline: "Checkmate: White wins", detail: "White wins" });
    expect(states[9]?.remark).toBeNull();
    expect(states.slice(0, 9).every((s) => s.banner === null)).toBe(true);
    expect(states[0]?.titleCard).toMatchObject({
      white: "White · GPT-4.1 Nano",
      black: "Black · GPT-4.1 Mini",
      versus: "vs",
    });
    expect(states[0]?.titleCard?.rules).toMatch(/^2 min each · /);
  });

  it("honours the toggles and the landscape size", () => {
    const off = buildVideoPlan(
      match,
      {
        aspect: "landscape",
        pace: "1",
        evalBar: false,
        remarks: false,
        clocks: false,
        illegal: false,
        lookups: false,
      },
      t,
    );
    expect(off).toMatchObject({ width: 1920, height: 1080 });
    for (const scene of off.scenes) {
      expect(scene.state.remark).toBeNull();
      expect(scene.state.evaluation).toBeNull();
      expect(scene.state.showEvalBar).toBe(false);
      expect(scene.state.players.w.clock).toBeNull();
    }
    expect(off.scenes[1]?.frames).toBe(30);
  });

  it("never carries an older position's evaluation forward", () => {
    const sparse = videoFixtureGame();
    // Keep only the evaluation after 1. e4.
    let kept = false;
    sparse.events = sparse.events.filter((event) => {
      if (event.type !== "evaluation") return true;
      if (kept) return false;
      kept = true;
      return true;
    });
    const sparseStates = buildVideoPlan(sparse, all, t).scenes.map((scene) => scene.state);
    expect(sparseStates[2]?.evaluation?.label).toBe("+0.3");
    expect(sparseStates.slice(3, 8).map((s) => s.evaluation)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(sparseStates[8]?.evaluation?.label).toBe("#");
  });

  it("names the forfeiting side and its rejected moves", () => {
    const forfeit = plainMatch(["e2e4", "e7e5", "d2d4", "e5d4", "d2d4", "d2d3", "d2d4"]);
    expect(forfeit.termination).toBe("illegal-forfeit");
    const banner = buildVideoPlan(forfeit, all, t).scenes.at(-1)?.state.banner;
    expect(banner).toEqual({
      headline: "White forfeited: 3 illegal moves",
      detail: "d2d4, d2d3, d2d4; its d-pawn had already moved",
    });
  });

  it("draws the spectators' evaluation of each position on the bar", () => {
    const plain = plainMatch(["e2e4", "e7e5"]);
    expect(videoFeatures(plain).evalBar).toBe(false);
    const spectator = Object.fromEntries(
      gamePositions(plain).map((fen, ply) => [
        String(ply),
        {
          engine: "stockfish-19-lite-single" as const,
          fen,
          depth: 9,
          nodes: 10000,
          cp: 150,
          mate: null,
          bestMove: null,
        },
      ]),
    );
    expect(videoFeatures(plain, spectator).evalBar).toBe(true);
    // Scores of other positions (stale) do not make a bar to show.
    const stale = Object.fromEntries(
      Object.entries(spectator).map(([ply, value]) => [
        ply,
        { ...value, fen: "8/8/8/8/8/8/8/K6k w - - 0 1" },
      ]),
    );
    expect(videoFeatures(plain, stale).evalBar).toBe(false);
    // Nor does an archived tool score of a position the game never reached.
    const tooled = plainMatch(["e2e4", "e7e5"]);
    tooled.events.push({
      type: "tool",
      seq: tooled.events.length,
      at: new Date().toISOString(),
      side: "w",
      ply: 2,
      name: "engine_eval",
      input: "{}",
      output: JSON.stringify({ ...spectator["0"], fen: "8/8/8/8/8/8/8/K6k w - - 0 1" }),
    });
    expect(videoFeatures(tooled).evalBar).toBe(false);
    const options = defaultVideoOptions(plain, spectator);
    expect(options.evalBar).toBe(true);
    const plan = buildVideoPlan(plain, options, t, { spectator });
    // Every position, the start included, shows its spectator score.
    const positions = plan.scenes.filter(
      (scene) => scene.state.kind !== "title" && scene.state.kind !== "final",
    );
    expect(positions.length).toBe(3);
    expect(positions.every((scene) => scene.state.evaluation?.label === "+1.5")).toBe(true);
  });
  it("keeps the spectators' score where the archive also scored the position", () => {
    const game = videoFixtureGame(); // carries after-move evaluations of its own
    const spectator = Object.fromEntries(
      gamePositions(game).map((fen, ply) => [
        String(ply),
        {
          engine: "stockfish-19-lite-single" as const,
          fen,
          depth: 9,
          nodes: 10000,
          cp: -420,
          mate: null,
          bestMove: null,
        },
      ]),
    );
    const plan = buildVideoPlan(game, defaultVideoOptions(game, spectator), t, { spectator });
    const labels = plan.scenes.flatMap((scene) =>
      scene.state.evaluation ? [scene.state.evaluation.label] : [],
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set(["−4.2"]));
  });

  it("stays inside 2:20 for a 200-ply game on auto", () => {
    const long = createMatch(
      {
        white: { name: "W", model: "w", protocol: "random" },
        black: { name: "B", model: "b", protocol: "random" },
        rules: {},
      },
      "hosted",
    );
    const chess = new Chess(long.config.initialFen);
    // Knights out and back: legal forever, no captures (draws by repetition stop it, so vary).
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8", "b1c3", "b8c6", "c3b1", "c6b8"];
    for (let i = 0; long.status === "running" && i < 200; i++) {
      submitMove(long, chess, shuffle[i % shuffle.length] as string);
    }
    const plan = buildVideoPlan(long, all, t);
    expect(plan.totalFrames / VIDEO_FPS).toBeLessThanOrEqual(X_MAX_SECONDS);
  });
});

describe("illegal attempts and lookups", () => {
  const match = videoIllegalFixtureGame();
  const options = defaultVideoOptions(match);
  const plan = buildVideoPlan(match, options, t);
  const kinds = plan.scenes.map((scene) => scene.state.kind);
  const frames = (seconds: number) => Math.round(seconds * VIDEO_FPS);

  it("is a valid archive under the keep-trying rule (it imports as a game)", async () => {
    const json = JSON.stringify(match);
    expect(() => validateArchive(JSON.parse(json))).not.toThrow();
    // Studio imports only finished games.
    expect(await checkArchiveFile({ size: json.length, text: async () => json })).toMatchObject({
      kind: "ok",
    });
  });

  it("turns both on by default when the game has them", () => {
    expect(videoFeatures(match)).toMatchObject({ illegal: true, lookups: true });
    expect(options).toMatchObject({ illegal: true, lookups: true });
  });

  it("orders each turn: lookups, illegal attempts, then the move", () => {
    // The 16-attempt turn: 3 played in full, then 13 flashes (on + off) and a hold.
    expect(kinds).toEqual([
      "title",
      "position",
      "lookup",
      "attempt",
      "position",
      "attempt",
      "position",
      "attempt",
      "position",
      "attempt",
      "attempt",
      "attempt",
      ...Array(13 * 2 + 1).fill("attempt"),
      "position",
      "final",
    ]);
  });

  it("slides, shakes and holds an attempt with a piece, captioned with the model", () => {
    const scene = plan.scenes[3];
    expect(scene?.frames).toBe(frames(ILLEGAL_MS / 1000) + frames(ILLEGAL_HOLD_SECONDS));
    expect(scene?.motion).toEqual({
      frames: frames(ILLEGAL_MS / 1000),
      ghosts: [{ piece: { type: "n", color: "w" }, from: "g1", to: "e5", effect: "illegal" }],
      hide: ["g1"],
    });
    expect(scene?.state.illegal).toEqual({
      squares: ["g1", "e5"],
      caption: "White tried Ng1-e5: not a legal move",
      speaker: "White · GPT-4.1 Nano",
      flash: null,
    });
    // In the position it was tried in, before the move.
    expect(scene?.state.fen).toBe(plan.scenes[1]?.state.fen);
    expect(scene?.state.toMove).toBe("w");
  });

  it("shows a lookup's dots on the position it was asked in", () => {
    const scene = plan.scenes[2];
    expect(scene?.frames).toBe(frames(LOOKUP_SECONDS));
    expect(scene?.state.lookup).toEqual({
      from: "g1",
      targets: [
        { square: "f3", capture: false },
        { square: "h3", capture: false },
      ],
    });
    expect(scene?.motion).toBeUndefined();
  });

  it("shows a lookup of a piece with no legal move: its square, no dots", () => {
    const blocked = videoIllegalFixtureGame();
    blocked.events.splice(1, 0, {
      ...blocked.events[0],
      input: JSON.stringify({ square: "a1" }),
    } as (typeof blocked.events)[number]);
    const scenes = buildVideoPlan(blocked, defaultVideoOptions(blocked), t).scenes;
    expect(scenes[3]?.state).toMatchObject({ kind: "lookup", lookup: { from: "a1", targets: [] } });
  });

  it("outlines an empty from-square without a slide, and flashes an unreadable reply's row", () => {
    const empty = plan.scenes[5];
    expect(empty?.motion).toBeUndefined();
    expect(empty?.frames).toBe(frames(STILL_ATTEMPT_SECONDS));
    expect(empty?.state.illegal).toMatchObject({
      squares: ["f6"],
      caption: "Black tried f6-e4: no Black piece on f6",
      flash: null,
    });
    const unreadable = plan.scenes[7];
    expect(unreadable?.motion).toBeUndefined();
    expect(unreadable?.state.illegal).toMatchObject({
      squares: [],
      caption: "White's reply couldn't be read as a move: “Knight takes e5!!”",
      flash: "w",
    });
  });

  it("plays the first 3 of a long run, then flashes the rest under a counter", () => {
    const run = plan.scenes.slice(9, 9 + 3 + 13 * 2 + 1);
    // Rooks through their own pawns: each of the first three slides out and back.
    expect(run.slice(0, 3).every((scene) => scene.motion?.ghosts.length === 1)).toBe(true);
    expect(run[0]?.state.illegal?.caption).toBe("Black tried Ra8-a5: not a legal move");
    expect(run[0]?.state.illegal?.squares).toEqual(["a8", "a5"]);
    const flashes = run.slice(3, -1);
    expect(new Set(flashes.map((scene) => scene.state.illegal?.caption))).toEqual(
      new Set(["+13 more illegal attempts"]),
    );
    // On (outlined) and off (blank) in turn, quick.
    expect(flashes.map((scene) => scene.frames)).toEqual(
      Array.from({ length: 26 }, (_, i) => (i % 2 === 0 ? FLASH_FRAMES - 1 : 1)),
    );
    // The 4th attempt of the turn (h8-h5's sibling h8-h3) is the first flash.
    expect(flashes[0]?.state.illegal?.squares).toEqual(["h8", "h3"]);
    expect(flashes[1]?.state.illegal?.squares).toEqual([]);
    expect(run.at(-1)?.state.illegal).toMatchObject({
      squares: [],
      caption: "+13 more illegal attempts",
    });
  });

  it("slides each move in the first frames of its position", () => {
    const move = plan.scenes[4];
    expect(move?.state.lastMove).toBe("g1f3");
    expect(move?.motion).toEqual({
      frames: 7,
      ghosts: [{ piece: { type: "n", color: "w" }, from: "g1", to: "f3", effect: "slide" }],
      hide: ["f3"],
    });
    // The start position has no move to slide.
    expect(plan.scenes[1]?.motion).toBeUndefined();
  });

  it("adds up to the plan's length and leaves the toggled-off extras out", () => {
    expect(plan.totalFrames).toBe(plan.scenes.reduce((n, scene) => n + scene.frames, 0));
    const off = buildVideoPlan(match, { ...options, illegal: false, lookups: false }, t);
    expect(off.scenes.map((scene) => scene.state.kind)).toEqual([
      "title",
      ...Array(5).fill("position"),
      "final",
    ]);
    expect(off.scenes.every((scene) => scene.state.illegal === null)).toBe(true);
    expect(off.totalFrames).toBeLessThan(plan.totalFrames);
  });

  it("keeps a long struggling game inside 2:20 on auto, shortening the extras", () => {
    const long = createMatch(
      {
        white: { name: "W", model: "w", protocol: "random" },
        black: { name: "B", model: "b", protocol: "random" },
        rules: { legalMoves: "tool" },
      },
      "hosted",
    );
    const chess = new Chess(long.config.initialFen);
    // Every pawn one step, twice over: 32 plies that never repeat a position.
    const pushes = [3, 4].flatMap((rank) =>
      [..."abcdefgh"].flatMap((file) => [
        `${file}${rank - 1}${file}${rank}`,
        `${file}${10 - rank}${file}${9 - rank}`,
      ]),
    );
    let rejected = 0;
    for (const push of pushes) {
      const i = long.events.filter((event) => event.type === "attempt" && event.accepted).length;
      for (let k = 0; k < 5; k++) {
        rejected++;
        long.events.push({
          type: "attempt",
          seq: long.events.length,
          at: new Date(0).toISOString(),
          side: chess.turn(),
          ply: i,
          move: chess.turn() === "w" ? "a1a5" : "a8a4",
          accepted: false,
          before: chess.fen(),
          fen: chess.fen(),
          san: null,
          reason: "illegal",
          comment: "",
        });
      }
      submitMove(long, chess, push);
    }
    expect(long.status).toBe("running");
    const auto = buildVideoPlan(long, defaultVideoOptions(long), t);
    expect(auto.totalFrames / VIDEO_FPS).toBeLessThanOrEqual(X_MAX_SECONDS);
    // Five a turn is not a long run: every one plays (shortened), none is left out.
    expect(auto.scenes.filter((scene) => scene.state.kind === "attempt").length).toBe(rejected);
    expect(rejected).toBe(160);
    // A fixed pace keeps every extra at full length.
    const fixed = buildVideoPlan(long, { ...defaultVideoOptions(long), pace: "0.5" }, t);
    expect(fixed.totalFrames).toBeGreaterThan(auto.totalFrames);
  });
});

describe("auto pace with many illegal attempts", () => {
  /** A seeded random game of `plies` plies, `attempts` rejected attempts before each move. */
  function struggling(plies: number, attempts: number, lookups = 0) {
    const match = createMatch(
      {
        white: { name: "W", model: "w", protocol: "random" },
        black: { name: "B", model: "b", protocol: "random" },
        rules: { legalMoves: "tool" },
      },
      "hosted",
    );
    const chess = new Chess(match.config.initialFen);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let ply = 0; ply < plies && match.status === "running"; ply++) {
      const base = { at: new Date(0).toISOString(), side: chess.turn(), ply };
      for (let k = 0; k < lookups; k++)
        match.events.push({
          ...base,
          type: "tool",
          seq: match.events.length,
          name: "legal_moves",
          input: JSON.stringify({ square: chess.turn() === "w" ? "g1" : "g8" }),
          output: "",
        });
      for (let k = 0; k < attempts; k++)
        match.events.push({
          ...base,
          type: "attempt",
          seq: match.events.length,
          move: chess.turn() === "w" ? "a1a5" : "a8a4",
          accepted: false,
          before: chess.fen(),
          fen: chess.fen(),
          san: null,
          reason: "illegal",
          comment: "",
        });
      const moves = legalMoves(chess);
      submitMove(match, chess, moves[Math.floor(random() * moves.length)] as string);
    }
    return match;
  }

  it.each([
    [80, 5, 0],
    [80, 5, 2],
    [120, 12, 1],
    [200, 3, 1],
    [300, 30, 2],
  ])(
    "fits %i plies with %i attempts and %i lookups a turn inside 2:20",
    (plies, attempts, lookups) => {
      const match = struggling(plies, attempts, lookups);
      const plan = buildVideoPlan(match, defaultVideoOptions(match), t);
      expect(plan.totalFrames).toBe(plan.scenes.reduce((n, scene) => n + scene.frames, 0));
      expect(plan.totalFrames / VIDEO_FPS).toBeLessThanOrEqual(X_MAX_SECONDS);
      // The struggle still shows.
      expect(plan.scenes.some((scene) => scene.state.kind === "attempt")).toBe(true);
    },
    // Building a 300-ply fixture event by event takes a few seconds on a busy machine.
    30_000,
  );

  it("thins the extras of an 850-ply game so every position keeps a frame", () => {
    const match = createMatch(
      {
        white: { name: "W", model: "w", protocol: "random" },
        black: { name: "B", model: "b", protocol: "random" },
        rules: {},
      },
      "hosted",
    );
    // Knights out and back forever; the plan replays moves, it does not end the game.
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    const chess = new Chess(match.config.initialFen);
    for (let ply = 0; ply < 850; ply++) {
      const base = { at: new Date(0).toISOString(), side: chess.turn(), ply, comment: "" };
      const fen = chess.fen();
      match.events.push({
        ...base,
        type: "attempt",
        seq: match.events.length,
        move: chess.turn() === "w" ? "g1e5" : "g8e4",
        accepted: false,
        before: fen,
        fen,
        san: null,
        reason: "illegal",
      });
      const move = shuffle[ply % 4] as string;
      const san = chess.move({ from: move.slice(0, 2), to: move.slice(2, 4) }).san;
      match.events.push({
        ...base,
        type: "attempt",
        seq: match.events.length,
        move,
        accepted: true,
        before: fen,
        fen: chess.fen(),
        san,
        reason: null,
      });
    }
    const plan = buildVideoPlan(match, defaultVideoOptions(match), t);
    expect(plan.scenes.filter((scene) => scene.state.kind === "position").length).toBe(851);
    expect(plan.totalFrames / VIDEO_FPS).toBeLessThanOrEqual(X_MAX_SECONDS);
    // One flash (ringed) per kept turn: some turns, not all 850.
    const flashes = plan.scenes.filter((scene) => scene.state.illegal?.squares.length).length;
    expect(flashes).toBeGreaterThan(100);
    expect(flashes).toBeLessThan(850);
  }, 30_000);

  it("keeps the normal compression while it fits", () => {
    const match = struggling(10, 8, 1);
    const plan = buildVideoPlan(match, defaultVideoOptions(match), t);
    const full = plan.scenes.filter((scene) => scene.motion && scene.state.kind === "attempt");
    // Three full attempts a turn, the rest under the counter, lookups kept.
    expect(full.length).toBe(30);
    expect(plan.scenes.filter((scene) => scene.state.kind === "lookup").length).toBe(10);
  });
});

describe("helpers", () => {
  it("strips control and bidi characters from remarks", () => {
    const [rlo, lri, zwj] = [0x202e, 0x2066, 0x200d].map((c) => String.fromCodePoint(c));
    expect(cleanRemark(`  a${rlo}b\u0000c\n\td${lri}e  `)).toBe("a b c d e");
    // Joiners inside emoji sequences survive.
    expect(cleanRemark(`👩${zwj}💻 gg`)).toBe(`👩${zwj}💻 gg`);
  });

  it("names the file after the title and result", () => {
    const named = (title: string, result: MatchArchive["result"]) =>
      videoFileName({
        ...videoFixtureGame(),
        result,
        config: { ...videoFixtureGame().config, title },
      });
    expect(named("Simple Test", "0-1")).toBe("simple-test-0-1.mp4");
    expect(named("Ça va? Égalité!", "1/2-1/2")).toBe("ca-va-egalite-draw.mp4");
    expect(named("../../etc", "*")).toBe("etc-unfinished.mp4");
    expect(named("♚♛", "1-0")).toBe("cockpit-chess-1-0.mp4");
  });
});
