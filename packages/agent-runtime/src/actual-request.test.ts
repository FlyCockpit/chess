import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createModelAdapter, outputTokenOptions } from "./adapters";
import { createRetryFailoverAdapter } from "./retry-adapter";
import type { AgentModel } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("actual provider requests through runtime retry/failover", () => {
  const primary: AgentModel = {
    provider: "openai-chat",
    model: "vendor/primary",
    apiKey: "synthetic-test-key",
    baseUrl: "https://openrouter.ai/api/v1",
  };

  it("durably authorizes and retains the charge bound of every failed retry and fallback", async () => {
    const reserved: string[] = [];
    const sent: string[] = [];
    const http = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const body = JSON.parse(await request.text());
      expect(request.redirect).toBe("error");
      expect(reserved).toEqual([...sent, body.model]);
      sent.push(body.model);
      return new Response(
        JSON.stringify({ error: { message: "charged failure", type: "server_error" } }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", http);
    const authorizeRequest: AgentModel["authorizeRequest"] = async (request) => {
      await Promise.resolve();
      reserved.push(JSON.parse(request.body).model);
      return undefined;
    };
    const models = [primary, { ...primary, model: "vendor/backup" }];
    const { adapter } = createRetryFailoverAdapter({
      candidates: models.map((model) => ({
        ...createModelAdapter({ ...model, authorizeRequest }),
        modelId: model.model,
        modelOptions: outputTokenOptions(model, 16),
      })),
      maxAttemptsPerModel: 2,
      sleep: async () => undefined,
    });
    const consume = async () => {
      for await (const _chunk of adapter.chatStream({
        model: primary.model,
        messages: [{ role: "user", content: "Hello" }],
        modelOptions: outputTokenOptions(primary, 16),
        threadId: "actual-request-test",
        logger: resolveDebugOption(false),
      })) {
        /* Consume the real SDK error stream. */
      }
    };
    await expect(consume()).rejects.toThrow("Model dispatch failed");
    expect(sent).toEqual(["vendor/primary", "vendor/primary", "vendor/backup", "vendor/backup"]);
    expect(reserved).toEqual(sent);
    expect(http).toHaveBeenCalledTimes(4);
  });

  it("cannot send another paid retry once durable authority refuses it", async () => {
    let held = 0;
    const http = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "charged failure", type: "server_error" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", http);
    const { adapter } = createRetryFailoverAdapter({
      candidates: [
        {
          ...createModelAdapter({
            ...primary,
            authorizeRequest: async () => {
              if (held >= 2) throw new Error("Local spend cap reached");
              held += 1;
              return undefined;
            },
          }),
          modelId: primary.model,
        },
      ],
      maxAttemptsPerModel: 3,
      sleep: async () => undefined,
    });
    const consume = async () => {
      for await (const _chunk of adapter.chatStream({
        model: primary.model,
        messages: [{ role: "user", content: "Hello" }],
        modelOptions: outputTokenOptions(primary, 16),
        threadId: "actual-request-test",
        logger: resolveDebugOption(false),
      })) {
        /* Consume all retry attempts. */
      }
    };
    await expect(consume()).rejects.toThrow();
    expect(held).toBe(2);
    expect(http).toHaveBeenCalledTimes(2);
  });
});
