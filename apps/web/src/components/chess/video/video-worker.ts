import { I420_COLOR_SPACE, rgbaToI420 } from "./video-color";
import { drawFrame, frameLayout } from "./video-frame";
import type { VideoAspect, VideoPlan } from "./video-plan";
import { H264_CODECS, type VideoWorkerRequest, type VideoWorkerResponse } from "./video-protocol";

/**
 * The MP4 encoder: draws each scene once on an OffscreenCanvas, converts it to
 * limited-range I420 (yuv420p) and encodes it as constant 30 fps H.264
 * through WebCodecs, muxed by Mediabunny. Mediabunny
 * is imported here only, on the first encode, so it never ships in a page
 * bundle. The page cancels by terminating this worker.
 */
type WorkerScope = {
  onmessage: ((event: MessageEvent<VideoWorkerRequest>) => void) | null;
  postMessage(message: VideoWorkerResponse, transfer: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

function post(message: VideoWorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

async function probe(width: number, height: number, bitrate: number): Promise<string | null> {
  if (typeof VideoEncoder === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (!new OffscreenCanvas(2, 2).getContext("2d")) return null;
  for (const codec of H264_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: 30,
        avc: { format: "avc" },
      });
      if (support.supported) return codec;
    } catch {
      // An invalid or unknown config throws in some engines: try the next one.
    }
  }
  return null;
}

async function encode(plan: VideoPlan, aspect: VideoAspect, codec: string) {
  const { BufferTarget, Mp4OutputFormat, Output, VideoSample, VideoSampleSource } = await import(
    "mediabunny"
  );
  const { width, height } = plan;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error("no-2d-context");
  const layout = frameLayout(aspect);
  const target = new BufferTarget();
  // fastStart "in-memory" writes the moov box before the media data.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const source = new VideoSampleSource({
    codec: "avc",
    fullCodecString: codec,
    bitrate: plan.bitrate,
    keyFrameInterval: 2,
    latencyMode: "quality",
  });
  output.addVideoTrack(source, { frameRate: plan.fps });
  await output.start();
  let frame = 0;
  let reported = 0;
  for (const scene of plan.scenes) {
    // Each scene is drawn and converted once; its frames reuse the same pixels.
    drawFrame(ctx, layout, scene.state);
    const pixels = rgbaToI420(ctx.getImageData(0, 0, width, height).data, width, height);
    for (let i = 0; i < scene.frames; i++) {
      const sample = new VideoSample(pixels, {
        format: "I420",
        codedWidth: width,
        codedHeight: height,
        timestamp: frame / plan.fps,
        duration: 1 / plan.fps,
        colorSpace: I420_COLOR_SPACE,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
      frame++;
      if (frame - reported >= 15) {
        reported = frame;
        post({ type: "progress", done: frame, total: plan.totalFrames });
      }
    }
  }
  source.close();
  await output.finalize();
  const buffer = target.buffer;
  if (!buffer) throw new Error("empty-output");
  post({ type: "done", buffer }, [buffer]);
}

scope.onmessage = (event: MessageEvent<VideoWorkerRequest>) => {
  const request = event.data;
  if (request.type === "probe") {
    void probe(request.width, request.height, request.bitrate).then((codec) =>
      post({ type: "probe", codec }),
    );
    return;
  }
  encode(request.plan, request.aspect, request.codec).catch((error: unknown) => {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
};
