import type { AgentModel } from "./types";

export interface ResponseIdentity {
  reportedModel?: string;
  reportedProvider?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const identity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\p{Cc}]/u.test(value)
    ? value
    : undefined;

function withBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(observed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return observed;
}

/** One bounded parser for diagnostic identity and durable actual-request settlement. */
function observeSseResponse(
  response: Response,
  observe: (
    data: string | undefined,
    complete: boolean,
    eventType?: string,
  ) => void | Promise<void>,
): Response {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response;
  const decoder = new TextDecoder();
  const maxChars = 65_536;
  let line = "";
  let data = "";
  let oversizedLine = false;
  let oversizedEvent = false;
  let eventType: string | undefined;
  const consumeEvent = async (complete: boolean) => {
    if (oversizedEvent || data)
      await observe(oversizedEvent ? undefined : data, complete, eventType);
    data = "";
    oversizedEvent = false;
    eventType = undefined;
  };
  const consumeLine = async () => {
    if (oversizedLine) oversizedEvent = true;
    else {
      const content = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!content) await consumeEvent(true);
      else if (content.startsWith("event:")) {
        const value = content.slice(6).replace(/^ /, "");
        if (value.length > 256) oversizedEvent = true;
        else eventType = value;
      } else if (content.startsWith("data:")) {
        const value = content.slice(5).replace(/^ /, "");
        if (data.length + value.length + 1 > maxChars) oversizedEvent = true;
        else if (!oversizedEvent) data += `${data ? "\n" : ""}${value}`;
      }
    }
    line = "";
    oversizedLine = false;
  };
  const consume = async (text: string) => {
    for (const part of text.split(/(?<=\n)/)) {
      const complete = part.endsWith("\n");
      const value = complete ? part.slice(0, -1) : part;
      if (line.length + value.length > maxChars) oversizedLine = true;
      else if (!oversizedLine) line += value;
      if (complete) await consumeLine();
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        await consume(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      async flush() {
        await consume(decoder.decode());
        if (line || oversizedLine) await consumeLine();
        await consumeEvent(false);
      },
    }),
  );
  // Preserve fetch metadata the SDK may use when constructing diagnostics.
  return withBody(response, body);
}

/**
 * Some gateways return a complete JSON object despite stream:true. Read only a
 * bounded prefix eagerly so terminal usage reaches the local financial classifier even if the SDK
 * rejects the non-SSE response immediately. Replay the original chunks unchanged;
 * an oversized response switches to backpressured passthrough without settlement.
 */
export async function responseJsonUsage(
  response: Response,
  protocol: AgentModel["provider"],
  onUsage: (usage: unknown) => Promise<void>,
  signal: AbortSignal,
): Promise<Response> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (
    !response.ok ||
    !response.body ||
    !(contentType === "application/json" || contentType?.endsWith("+json"))
  )
    return response;
  const maxBytes = 65_536;
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes)
    return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  const read = () =>
    new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      reader.read().then(
        (next) => {
          signal.removeEventListener("abort", onAbort);
          resolve(next);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  try {
    while (size <= maxBytes) {
      signal.throwIfAborted();
      const next = await read();
      signal.throwIfAborted();
      if (next.done) {
        done = true;
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    if (done) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let payload: Record<string, unknown> | undefined;
      try {
        payload = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      } catch {
        /* Unparseable reports retain their full reservation. */
      }
      const usage = record(payload?.usage);
      const terminal =
        protocol === "anthropic"
          ? payload?.type === "message" &&
            [
              "end_turn",
              "stop_sequence",
              "max_tokens",
              "tool_use",
              "pause_turn",
              "refusal",
            ].includes(String(payload.stop_reason))
          : protocol === "openai-responses"
            ? payload?.object === "response" && payload.status === "completed"
            : Array.isArray(payload?.choices) &&
              payload.choices.length > 0 &&
              payload.choices.every((choice) =>
                ["stop", "length", "tool_calls", "function_call", "content_filter"].includes(
                  String(record(choice)?.finish_reason),
                ),
              );
      if (
        payload &&
        payload.error == null &&
        (!("status" in payload) || payload.status === "completed") &&
        usage &&
        terminal
      ) {
        signal.throwIfAborted();
        // The reservation owner validates reported cost or exact locally priced
        // categories. Missing/unpriced categories retain its full reservation.
        await onUsage(usage);
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  let index = 0;
  return withBody(
    response,
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) {
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
          if (done && index === chunks.length) controller.close();
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  );
}

/**
 * Observe response-reported identities before SDKs discard or default them. The
 * bounded SSE parser forwards the original byte chunks unchanged and never tees
 * the response. Missing, malformed and oversized events leave identity unknown.
 */
export const responseIdentityFetch =
  (
    protocol: AgentModel["provider"],
    observe: (value: ResponseIdentity) => void,
    base?: typeof fetch,
  ): typeof fetch =>
  async (input, init) => {
    observe({});
    const fetcher = base ?? globalThis.fetch;
    // Bun must receive Request objects without a second undefined argument.
    const response = init === undefined ? await fetcher(input) : await fetcher(input, init);
    const current: ResponseIdentity = {};
    return observeSseResponse(response, (data) => {
      try {
        if (!data) return;
        const event = record(JSON.parse(data));
        const payload =
          protocol === "anthropic"
            ? event?.type === "message_start"
              ? record(event.message)
              : undefined
            : protocol === "openai-responses"
              ? record(event?.response)
              : Array.isArray(event?.choices)
                ? event
                : undefined;
        const model = identity(payload?.model);
        const provider = identity(payload?.provider);
        if (model !== undefined) current.reportedModel = model;
        if (provider !== undefined) current.reportedProvider = provider;
        if (model !== undefined || provider !== undefined) observe({ ...current });
      } catch {
        // Identity diagnostics must never change stream/failure behavior.
      }
    });
  };

/**
 * Bind a terminal usage report to the one actual HTTP reservation that sent it.
 * The async observer runs before forwarding those exact terminal bytes, so an SDK
 * that closes its reader immediately upon completion cannot skip durable settlement.
 * Unsupported/malformed/incomplete reports retain the full conservative hold.
 */
export function responseUsage(
  response: Response,
  protocol: AgentModel["provider"],
  onUsage: (usage: unknown) => Promise<void>,
  signal: AbortSignal,
): Response {
  let settled = false;
  let invalid = false;
  let finished = false;
  let usage: Record<string, unknown> | undefined;
  let anthropicDelta = false;
  const settle = async () => {
    if (settled || invalid || signal.aborted || !usage) return;
    settled = true;
    // Financial callbacks deliberately propagate failures; they are not diagnostics.
    await onUsage(usage);
  };
  return observeSseResponse(response, async (data, complete, eventType) => {
    if (settled || invalid || !complete || signal.aborted) return;
    if (eventType === "error") {
      invalid = true;
      return;
    }
    if (data === "[DONE]") {
      if (protocol === "openrouter" || protocol === "openai-chat") await settle();
      return;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = data === undefined ? undefined : record(JSON.parse(data));
    } catch {
      invalid = true;
      return;
    }
    if (
      !event ||
      event.error != null ||
      event.type === "error" ||
      event.type === "response.failed"
    ) {
      invalid = true;
      return;
    }
    if (protocol === "anthropic") {
      if (event.type === "message_start") usage = record(record(event.message)?.usage);
      if (event.type === "message_delta") {
        const delta = record(event.usage);
        if (usage && delta) {
          usage = { ...usage, ...delta };
          anthropicDelta = typeof delta.output_tokens === "number";
        }
        if (record(event.delta)?.stop_reason != null) finished = true;
      }
      if (event.type === "message_stop" && finished && anthropicDelta) await settle();
    } else if (protocol === "openai-responses") {
      if (event.type === "response.completed") {
        usage = record(record(event.response)?.usage);
        await settle();
      }
    } else if (Array.isArray(event.choices)) {
      if (event.choices.some((choice) => record(choice)?.finish_reason != null)) finished = true;
      const reported = record(event.usage);
      if (reported) usage = reported;
      if (finished && reported) await settle();
    }
  });
}
