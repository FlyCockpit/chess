import { Chess, createMatch, type MatchArchive, submitMove } from "@cockpit-chess/chess";
import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { videoFixtureGame } from "./video-fixture";
import {
  AUTO_MAX_SECONDS_PER_MOVE,
  buildVideoPlan,
  cleanRemark,
  defaultVideoOptions,
  FINAL_HOLD_SECONDS,
  pacing,
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
    expect(videoFeatures(match)).toEqual({ evalBar: false, remarks: false, clocks: false });
    expect(defaultVideoOptions(match)).toEqual({
      aspect: "square",
      pace: "auto",
      evalBar: false,
      remarks: false,
      clocks: false,
    });
  });
});

describe("frame plan", () => {
  const match = videoFixtureGame();
  const plan = buildVideoPlan(match, all, t);
  const states = plan.scenes.map((scene) => scene.state);

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
    expect(states[9]?.banner).toEqual({ headline: "Checkmate: White wins", detail: "Checkmate" });
    expect(states[9]?.remark).toBeNull();
    expect(states.slice(0, 9).every((s) => s.banner === null)).toBe(true);
    expect(states[0]?.titleCard).toMatchObject({
      white: "White · GPT-4.1 Nano",
      black: "Black · GPT-4.1 Mini",
      versus: "vs",
    });
  });

  it("honours the toggles and the landscape size", () => {
    const off = buildVideoPlan(
      match,
      { aspect: "landscape", pace: "1", evalBar: false, remarks: false, clocks: false },
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
      headline: "White forfeited: Black wins",
      detail: "Illegal-move forfeit: d2d4, d2d3, d2d4",
    });
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
