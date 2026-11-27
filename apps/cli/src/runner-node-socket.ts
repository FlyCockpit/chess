import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
} from "@cockpit-chess/chess/runner-protocol";
import WebSocket, { type RawData } from "ws";

import type { RunnerSocketEvents, RunnerSocketFactory } from "./runner-connection";

const MAX_CHALLENGES = 3;
const MAX_CONTROL_FRAMES = 240;
const ignoreError = () => {};

/** Concrete transport for RunnerConnection, which validates the endpoint and owns session authority. */
export const createNodeRunnerSocket: RunnerSocketFactory = (url, options) => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, {
      headers: { Authorization: options.headers.Authorization },
      maxPayload: RUNNER_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      maxRedirects: 0,
      handshakeTimeout: 10_000,
      allowSynchronousEvents: false,
      autoPong: true,
      maxFragments: 128,
      maxBufferedChunks: 128,
      rejectUnauthorized: true,
    });
  } catch {
    throw new Error("RUNNER_SOCKET_CONNECTION_FAILED");
  }

  let events: RunnerSocketEvents | undefined;
  let subscribed = false;
  let stopped = false;
  let finished = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let bufferWatch: ReturnType<typeof setInterval> | undefined;
  let forceClose: ReturnType<typeof setTimeout> | undefined;
  const challenges = new Map<string, ReturnType<typeof setTimeout>>();
  const controls: number[] = [];

  function clearOperational() {
    clearInterval(heartbeat);
    clearInterval(bufferWatch);
    heartbeat = undefined;
    bufferWatch = undefined;
    for (const timer of challenges.values()) clearTimeout(timer);
    challenges.clear();
    controls.length = 0;
    socket.off("open", onOpen);
    socket.off("message", onMessage);
    socket.off("ping", onPing);
    socket.off("pong", onPong);
    socket.off("unexpected-response", onUnexpectedResponse);
  }

  function finish() {
    if (finished) return;
    finished = true;
    stopped = true;
    const observer = events;
    events = undefined;
    clearOperational();
    clearTimeout(forceClose);
    forceClose = undefined;
    socket.off("close", onClose);
    socket.off("error", onError);
    // A permanent, inert error sink also covers ws's next-tick CONNECTING abort errors.
    return observer;
  }

  function terminate() {
    try {
      socket.terminate();
    } catch {
      // Teardown never exposes transport errors or handshake credentials.
    }
  }

  function fail() {
    if (finished) return;
    const observer = finish();
    terminate();
    observer?.error();
  }

  function checkBuffer(extraBytes = 0): boolean {
    const buffered = socket.bufferedAmount;
    if (
      !Number.isFinite(buffered) ||
      buffered < 0 ||
      buffered + extraBytes > RUNNER_MAX_BUFFERED_BYTES
    ) {
      fail();
      return false;
    }
    return true;
  }

  function onError() {
    fail();
  }

  function onClose(code: number) {
    finish()?.close(code);
  }

  function ping() {
    if (stopped || !checkBuffer()) return;
    if (socket.readyState !== WebSocket.OPEN || challenges.size >= MAX_CHALLENGES) {
      fail();
      return;
    }
    const nonce = randomUUID();
    challenges.set(nonce, setTimeout(fail, RUNNER_LIVENESS_MS));
    try {
      socket.ping(nonce, true, (error) => {
        if (error) fail();
      });
      if (!stopped) checkBuffer();
    } catch {
      fail();
    }
  }

  function onOpen() {
    if (stopped || !checkBuffer()) return;
    // ws autoPong answers the peer's native pings; these challenges test the other direction.
    heartbeat = setInterval(ping, RUNNER_HEARTBEAT_MS);
    bufferWatch = setInterval(() => checkBuffer(), 1000);
    events?.open();
  }

  function onMessage(data: RawData, isBinary: boolean) {
    if (stopped || !checkBuffer()) return;
    // ws has already enforced maxPayload and UTF-8 validity before emitting this event.
    const normalized = isBinary
      ? data
      : (Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data)
        ).toString("utf8");
    events?.message(normalized, isBinary);
  }

  function acceptControl(): boolean {
    if (stopped || !checkBuffer()) return false;
    const now = Date.now();
    while (controls.length && (controls[0] ?? now) <= now - 60_000) controls.shift();
    if (controls.length >= MAX_CONTROL_FRAMES) {
      fail();
      return false;
    }
    controls.push(now);
    return true;
  }

  function onPing() {
    acceptControl();
  }

  function onPong(data: Buffer) {
    if (!acceptControl()) return;
    const nonce = data.toString("utf8");
    const deadline = challenges.get(nonce);
    if (deadline === undefined) return;
    clearTimeout(deadline);
    challenges.delete(nonce);
  }

  function onUnexpectedResponse(request: ClientRequest, response: IncomingMessage) {
    const observer = finish();
    const unauthorized = response.statusCode === 401 || response.statusCode === 403;
    // Installing this handler suppresses ws's default handshake abort, so destroy every carrier.
    // Do not read headers, status text, Location, or any response body.
    const streams = new Set([response, request, response.socket, request.socket]);
    for (const stream of streams) {
      if (!stream) continue;
      stream.on("error", ignoreError);
      stream.destroy();
    }
    terminate();
    if (unauthorized) observer?.close(4401);
    else observer?.error();
  }

  socket.on("error", ignoreError);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.on("open", onOpen);
  socket.on("message", onMessage);
  socket.on("ping", onPing);
  socket.on("pong", onPong);
  socket.on("unexpected-response", onUnexpectedResponse);

  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send(frame) {
      if (stopped || socket.readyState !== WebSocket.OPEN) {
        fail();
        throw new Error("RUNNER_SOCKET_SEND_FAILED");
      }
      if (!checkBuffer(Buffer.byteLength(frame, "utf8")))
        throw new Error("RUNNER_SOCKET_SEND_FAILED");
      try {
        socket.send(frame, { binary: false, compress: false }, (error) => {
          if (error) fail();
          else if (!stopped) checkBuffer();
        });
      } catch {
        fail();
        throw new Error("RUNNER_SOCKET_SEND_FAILED");
      }
      if (!stopped) checkBuffer();
    },
    close(code) {
      if (finished || forceClose !== undefined) return;
      stopped = true;
      clearOperational();
      if (socket.readyState === WebSocket.CLOSED) {
        finish();
        return;
      }
      if (socket.readyState === WebSocket.CONNECTING) {
        finish();
        terminate();
        return;
      }
      forceClose = setTimeout(() => {
        const observer = finish();
        terminate();
        observer?.close(1006);
      }, 1000);
      try {
        socket.close(code);
      } catch {
        fail();
      }
    },
    subscribe(observer) {
      if (stopped) return () => {};
      if (subscribed) throw new Error("RUNNER_SOCKET_ALREADY_SUBSCRIBED");
      subscribed = true;
      events = observer;
      return () => {
        if (events !== observer) return;
        events = undefined;
        stopped = true;
        clearOperational();
        // Retain close/error cleanup until the socket finishes, including any forced-close timer.
      };
    },
  };
};
