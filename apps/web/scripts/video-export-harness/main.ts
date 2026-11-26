import { type MatchArchive, validateArchive } from "@cockpit-chess/chess";
import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { encodeVideo, probeVideoSupport } from "../../src/components/chess/video/video-export";
import { videoFixtureGame } from "../../src/components/chess/video/video-fixture";
import {
  buildVideoPlan,
  defaultVideoOptions,
  type VideoAspect,
  videoFileName,
} from "../../src/components/chess/video/video-plan";

/**
 * Browser side of the MP4 integration test (scripts/video-export-integration.ts):
 * runs the real worker, encoder and muxer, then uploads the file to the test
 * server, which checks it with ffprobe.
 */
type Run = { aspect: VideoAspect; archive?: unknown; upload: string };

const i18n = i18next.createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { chess: chessEn } },
  interpolation: { escapeValue: false },
});

async function run({ aspect, archive, upload }: Run) {
  await ready;
  const t = i18n.getFixedT("en", "chess") as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
  const match: MatchArchive = archive ? validateArchive(archive) : videoFixtureGame();
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

Object.assign(window, { videoExport: { run, cancel } });
document.title = "ready";
