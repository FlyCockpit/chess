import type { AgentModel } from "./types";

export interface ResponseIdentity {
  reportedModel?: string;
  reportedProvider?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const identity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\p{Cc}]/u.test(value)
    ? value
    : undefined;

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
    // Every actual HTTP request (including retries) owns a fresh identity.
    observe({});
    const fetcher = base ?? globalThis.fetch;
    // Bun distinguishes fetch(request) from fetch(request, undefined); the latter
    // can discard the Request's method, headers and body (the SDK avoids it too).
    const response = init === undefined ? await fetcher(input) : await fetcher(input, init);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      return response;
    const decoder = new TextDecoder();
    const current: ResponseIdentity = {};
    const maxChars = 65_536;
    let line = "";
    let data = "";
    let oversizedLine = false;
    let oversizedEvent = false;
    const consumeEvent = () => {
      try {
        if (!oversizedEvent && data) {
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
        }
      } catch {
        // Diagnostics must never alter a provider stream or its failure behavior.
      }
      data = "";
      oversizedEvent = false;
    };
    const consumeLine = () => {
      if (oversizedLine) oversizedEvent = true;
      else {
        const content = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!content) consumeEvent();
        else if (content.startsWith("data:")) {
          const value = content.slice(5).replace(/^ /, "");
          if (data.length + value.length + 1 > maxChars) oversizedEvent = true;
          else if (!oversizedEvent) data += `${data ? "\n" : ""}${value}`;
        }
      }
      line = "";
      oversizedLine = false;
    };
    const consume = (text: string) => {
      for (const part of text.split(/(?<=\n)/)) {
        const complete = part.endsWith("\n");
        const value = complete ? part.slice(0, -1) : part;
        if (line.length + value.length > maxChars) oversizedLine = true;
        else if (!oversizedLine) line += value;
        if (complete) consumeLine();
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          consume(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          consume(decoder.decode());
          if (line || oversizedLine) consumeLine();
          consumeEvent();
        },
      }),
    );
    const observed = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Preserve fetch metadata the SDK may use when constructing diagnostics.
    Object.defineProperties(observed, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return observed;
  };
