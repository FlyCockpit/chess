import { type MatchArchive, validateArchive } from "@cockpit-chess/chess";
import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { encodeVideo, probeVideoSupport } from "../../src/components/chess/video/video-export";
import {
  videoFixtureGame,
  videoIllegalFixtureGame,
  videoPromotionFixtureGame,
} from "../../src/components/chess/video/video-fixture";
import { frameLayout } from "../../src/components/chess/video/video-frame";
import {
  buildVideoPlan,
  defaultVideoOptions,
  type VideoAspect,
  type VideoPlan,
  videoFileName,
} from "../../src/components/chess/video/video-plan";

/**
 * Browser side of the MP4 integration test (scripts/video-export-integration.ts):
 * runs the real worker, encoder and muxer, then uploads the file to the test
 * server, which checks it with ffprobe.
 */
type Run = {
  aspect: VideoAspect;
  archive?: unknown;
  fixture?: "struggle" | "promotion";
  upload: string;
};

/**
 * Frames worth looking at: a move mid-slide, the first illegal attempt mid-shake and in
 * its hold, a lookup, an unreadable reply and a long run's counter. Each with the board
 * squares the check expects ringed in red (none for the others).
 */
function frameMarks(plan: VideoPlan) {
  const marks: Array<{
    label: string;
    frame: number;
    ringed: string[];
    /** The scene's first still frame, and frames at ¼ ½ ¾ of the motion: all different. */
    sequence?: number[];
    /**
     * A promotion square and the last motion frame, where the pawn stands on it: the
     * frame must show another piece there (the new one), not the pawn.
     */
    crowned?: { square: string; pawnFrame: number };
  }> = [];
  const once = (label: string, frame: number, ringed: string[] = [], sequence?: number[]) => {
    if (!marks.some((mark) => mark.label === label)) marks.push({ label, frame, ringed, sequence });
  };
  const through = (start: number, frames: number) => [
    ...[1, 2, 3].map((quarter) => start + Math.floor((frames * quarter) / 4)),
    start + frames,
  ];
  let start = 0;
  for (const scene of plan.scenes) {
    const { state, motion } = scene;
    // A frame mid-motion, and the scene's first still frame, which must differ from it.
    if (state.kind === "position" && motion)
      once("slide", start + Math.floor(motion.frames / 2), [], through(start, motion.frames));
    // A promotion: the queen right after the pawn lands, and late in the hold.
    if (state.kind === "position" && motion && state.lastMove?.length === 5) {
      const square = state.lastMove.slice(2, 4);
      const crowned = { square, pawnFrame: start + motion.frames - 1 };
      marks.push({ label: "promoted", frame: start + motion.frames, ringed: [], crowned });
      marks.push({ label: "promoted-hold", frame: start + scene.frames - 1, ringed: [], crowned });
    }
    if (state.kind === "lookup") once("lookup", start + 2);
    if (state.kind === "attempt" && motion) {
      once(
        "illegal-shake",
        start + Math.floor(motion.frames / 2),
        state.illegal?.squares,
        through(start, motion.frames),
      );
      once("illegal-hold", start + motion.frames + 3, state.illegal?.squares);
    }
    if (state.illegal?.flash) once("unreadable", start + 3);
    if (state.illegal?.caption.startsWith("+") && state.illegal.squares.length > 0)
      once("burst", start + 1, state.illegal.squares);
    start += scene.frames;
  }
  return marks;
}

const i18n = i18next.createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { chess: chessEn } },
  interpolation: { escapeValue: false },
});

async function run({ aspect, archive, fixture, upload }: Run) {
  await ready;
  const t = i18n.getFixedT("en", "chess") as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
  const match: MatchArchive = archive
    ? validateArchive(archive)
    : fixture === "struggle"
      ? videoIllegalFixtureGame()
      : fixture === "promotion"
        ? videoPromotionFixtureGame()
        : videoFixtureGame();
  const codec = await probeVideoSupport(aspect);
  if (!codec) return { error: "unsupported" };
  const options = { ...defaultVideoOptions(match), aspect };
  const plan = buildVideoPlan(match, options, t);
  let progressEvents = 0;
  const started = performance.now();
  const blob = await encodeVideo(
    plan,
    aspect,
    codec,
    () => {
      progressEvents++;
    },
    new AbortController().signal,
  );
  const response = await fetch(upload, { method: "POST", body: blob });
  if (!response.ok) return { error: `upload ${response.status}` };
  return {
    codec,
    fileName: videoFileName(match),
    bytes: blob.size,
    totalFrames: plan.totalFrames,
    seconds: plan.totalFrames / plan.fps,
    width: plan.width,
    height: plan.height,
    progressEvents,
    encodeMs: Math.round(performance.now() - started),
    marks: frameMarks(plan),
    board: VIDEO_BOARDS[aspect],
  };
}

/** Cancelling must stop the worker and reject with AbortError, leaving no file. */
async function cancel() {
  await ready;
  const t = i18n.getFixedT("en", "chess") as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
  const match = videoFixtureGame();
  const codec = await probeVideoSupport("square");
  if (!codec) return { error: "unsupported" };
  const plan = buildVideoPlan(match, defaultVideoOptions(match), t);
  const controller = new AbortController();
  let progressAfterCancel = 0;
  const pending = encodeVideo(
    plan,
    "square",
    codec,
    () => {
      if (controller.signal.aborted) progressAfterCancel++;
      else controller.abort();
    },
    controller.signal,
  );
  try {
    await pending;
    return { error: "not cancelled" };
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { name: (error as Error).name, progressAfterCancel };
  }
}

const VIDEO_BOARDS = {
  square: frameLayout("square").board,
  landscape: frameLayout("landscape").board,
};

Object.assign(window, { videoExport: { run, cancel } });
document.title = "ready";
