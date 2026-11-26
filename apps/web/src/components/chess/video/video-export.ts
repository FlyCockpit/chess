import { VIDEO_SIZES, type VideoAspect, type VideoPlan } from "./video-plan";
import type { VideoWorkerRequest, VideoWorkerResponse } from "./video-protocol";

/**
 * Page side of the MP4 export. Each call owns one worker; cancelling (or an
 * error) terminates it, which also frees every frame and the partial file.
 */
function startWorker() {
  return new Worker(new URL("./video-worker.ts", import.meta.url), {
    type: "module",
    name: "video-export",
  });
}

function request<T extends VideoWorkerResponse["type"]>(
  worker: Worker,
  message: VideoWorkerRequest,
  until: T,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Extract<VideoWorkerResponse, { type: T }>> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new DOMException("Video export cancelled", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<VideoWorkerResponse>) => {
      const data = event.data;
      if (data.type === "progress") onProgress?.(data.done, data.total);
      else if (data.type === "error") {
        finish();
        reject(new Error(data.message));
      } else if (data.type === until) {
        finish();
        resolve(data as Extract<VideoWorkerResponse, { type: T }>);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      reject(new Error(event.message || "video worker failed"));
    };
    worker.postMessage(message);
  });
}

/**
 * The H.264 codec string the browser can encode at this size, or null when it
 * has no WebCodecs H.264 encoder (or no module workers / OffscreenCanvas).
 * Checked inside a worker, where the encoding actually happens.
 */
export async function probeVideoSupport(
  aspect: VideoAspect,
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof Worker === "undefined") return null;
  const size = VIDEO_SIZES[aspect];
  try {
    const result = await request(
      startWorker(),
      { type: "probe", width: size.width, height: size.height, bitrate: size.bitrate },
      "probe",
      undefined,
      signal,
    );
    return result.codec;
  } catch {
    return null;
  }
}

export async function encodeVideo(
  plan: VideoPlan,
  aspect: VideoAspect,
  codec: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const result = await request(
    startWorker(),
    { type: "encode", plan, aspect, codec },
    "done",
    onProgress,
    signal,
  );
  return new Blob([result.buffer], { type: "video/mp4" });
}

/**
 * A run counter for async answers: `start()` returns a check that is true only
 * while no later run started and nothing invalidated it, so a slow answer can
 * never overwrite the state a newer action set.
 */
export function createGeneration() {
  let current = 0;
  return {
    start() {
      const run = ++current;
      return () => run === current;
    },
    invalidate() {
      current++;
    },
  };
}
