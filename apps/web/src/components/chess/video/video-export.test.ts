import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeneration, encodeVideo, probeVideoSupport } from "./video-export";
import type { VideoPlan } from "./video-plan";
import type { VideoWorkerRequest, VideoWorkerResponse } from "./video-protocol";

/** A stand-in worker: records requests and termination; tests answer by hand. */
class FakeWorker {
  static last: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<VideoWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: VideoWorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: VideoWorkerRequest) {
    this.requests.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: VideoWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<VideoWorkerResponse>);
  }
}

const plan: VideoPlan = {
  width: 1080,
  height: 1080,
  bitrate: 1,
  fps: 30,
  scenes: [],
  totalFrames: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.last = undefined;
});

describe("probeVideoSupport", () => {
  it("is null where module workers do not exist", async () => {
    vi.stubGlobal("Worker", undefined);
    expect(await probeVideoSupport("square")).toBeNull();
  });

  it("asks a worker at the chosen size, then terminates it", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pending = probeVideoSupport("landscape");
    const worker = FakeWorker.last as FakeWorker;
    expect(worker.requests).toEqual([
      { type: "probe", width: 1920, height: 1080, bitrate: 3_500_000 },
    ]);
    worker.reply({ type: "probe", codec: "avc1.4d0028" });
    expect(await pending).toBe("avc1.4d0028");
    expect(worker.terminated).toBe(true);
  });

  it("stops the worker when aborted (dialog closed or unmounted)", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = probeVideoSupport("square", controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(FakeWorker.last?.terminated).toBe(true);
  });
});

describe("encodeVideo", () => {
  it("reports progress and returns an MP4 blob", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const progress = vi.fn();
    const pending = encodeVideo(
      plan,
      "square",
      "avc1.4d0028",
      progress,
      new AbortController().signal,
    );
    const worker = FakeWorker.last as FakeWorker;
    worker.reply({ type: "progress", done: 15, total: 30 });
    worker.reply({ type: "done", buffer: new Uint8Array([1, 2, 3]).buffer });
    const blob = await pending;
    expect(progress).toHaveBeenCalledWith(15, 30);
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBe(3);
    expect(worker.terminated).toBe(true);
  });

  it("cancels by terminating the worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = encodeVideo(plan, "square", "avc1.4d0028", () => {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.last?.terminated).toBe(true);
  });

  it("fails, and terminates, on an encoder error", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pending = encodeVideo(
      plan,
      "square",
      "avc1.4d0028",
      () => {},
      new AbortController().signal,
    );
    FakeWorker.last?.reply({ type: "error", message: "EncodingError" });
    await expect(pending).rejects.toThrow("EncodingError");
    expect(FakeWorker.last?.terminated).toBe(true);
  });
});

describe("createGeneration", () => {
  it("keeps only the latest run current", () => {
    const generation = createGeneration();
    const first = generation.start();
    expect(first()).toBe(true);
    const second = generation.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("invalidates every run, e.g. when the dialog closes or an export starts", () => {
    const generation = createGeneration();
    const run = generation.start();
    generation.invalidate();
    expect(run()).toBe(false);
    expect(generation.start()()).toBe(true);
  });
});
