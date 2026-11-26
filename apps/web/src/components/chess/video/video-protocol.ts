import type { VideoAspect, VideoPlan } from "./video-plan";

/**
 * H.264 in the order tried: Main profile level 4.0, then Constrained Baseline
 * level 4.0. Both are 4:2:0 (yuv420p) and cover 1920×1080 at 30 fps, which is
 * what X accepts.
 */
export const H264_CODECS = ["avc1.4d0028", "avc1.42e028"] as const;

export type VideoWorkerRequest =
  | { type: "probe"; width: number; height: number; bitrate: number }
  | { type: "encode"; plan: VideoPlan; aspect: VideoAspect; codec: string };

export type VideoWorkerResponse =
  | { type: "probe"; codec: string | null }
  | { type: "progress"; done: number; total: number }
  | { type: "done"; buffer: ArrayBuffer }
  | { type: "error"; message: string };
