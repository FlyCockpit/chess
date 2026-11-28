import { z } from "zod";
import { RUNNER_REPLACEMENT_CHANNEL } from "./runner-ws-store.js";

const replacement = z
  .object({
    machineId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    generation: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const commandWake = replacement.pick({ machineId: true });

interface Subscriber {
  on(event: "ready" | "close" | "error", listener: () => void): unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  subscribe(...channels: string[]): Promise<unknown>;
  disconnect(): void;
}
type Notifications = {
  onInvalidate: (event: { userId: string; machineId?: string }) => void;
  onUnavailable: () => void;
  onReady: () => void;
};

/** Losing either notification channel closes sockets; durable checks remain mandatory. */
export function createRunnerInvalidationMonitor(options: {
  subscriber: Subscriber;
  startNotifications: (callbacks: Notifications) => { stop: () => Promise<void> };
  invalidate: (userId?: string, machineId?: string, generation?: number) => void;
  commandChannel?: string;
  wake?: (machineId: string) => void;
}) {
  let stopped = false;
  let pgReady = false;
  let redisReady = false;
  let revision = 0;
  let subscribing: Promise<unknown> | undefined;
  function unavailable() {
    options.invalidate();
  }
  options.subscriber.on("ready", () => {
    const attempt = ++revision;
    redisReady = false;
    subscribing = options.subscriber
      .subscribe(
        RUNNER_REPLACEMENT_CHANNEL,
        ...(options.commandChannel ? [options.commandChannel] : []),
      )
      .then(() => {
        if (!stopped && attempt === revision) redisReady = true;
      })
      .catch(() => {
        if (attempt !== revision) return;
        redisReady = false;
        unavailable();
      });
  });
  for (const event of ["close", "error"] as const) {
    options.subscriber.on(event, () => {
      ++revision;
      redisReady = false;
      unavailable();
    });
  }
  options.subscriber.on("message", (channel, message) => {
    if (stopped || Buffer.byteLength(message) > 1024) return;
    try {
      if (channel === RUNNER_REPLACEMENT_CHANNEL) {
        const data = replacement.parse(JSON.parse(message));
        options.invalidate(undefined, data.machineId, data.generation);
      } else if (channel === options.commandChannel) {
        const data = commandWake.parse(JSON.parse(message));
        options.wake?.(data.machineId);
      }
    } catch {
      // Do not echo untrusted pubsub bodies or parse errors into operational logs.
    }
  });
  const notifications = options.startNotifications({
    onInvalidate: ({ userId, machineId }) => {
      if (!stopped) options.invalidate(userId, machineId);
    },
    onUnavailable: () => {
      pgReady = false;
      unavailable();
    },
    onReady: () => {
      if (!stopped) pgReady = true;
    },
  });
  return {
    isAvailable: () => !stopped && pgReady && redisReady,
    async stop() {
      stopped = true;
      ++revision;
      pgReady = false;
      redisReady = false;
      options.subscriber.disconnect();
      await notifications.stop();
      await subscribing;
    },
  };
}
