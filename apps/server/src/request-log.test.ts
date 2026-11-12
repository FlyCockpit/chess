import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestLog, sanitizedRequestPath } from "./request-log";

afterEach(() => vi.restoreAllMocks());

describe("sanitizedRequestPath", () => {
  it.each([
    [
      "/api/auth/reset-password/PATH_SENTINEL?callbackURL=QUERY_SENTINEL",
      "/api/auth/reset-password/[redacted]",
    ],
    ["/api/auth/reset-password/ENCODED%2FSENTINEL", "/api/auth/reset-password/[redacted]"],
    ["/api/auth/verify-email?token=QUERY_SENTINEL", "/api/auth/verify-email"],
    [
      "/api/auth/callback/provider?code=CODE_SENTINEL&state=STATE_SENTINEL",
      "/api/auth/callback/provider",
    ],
    ["/en-US/reset-password?token=QUERY_SENTINEL", "/en-US/reset-password"],
    ["/rpc/chess/list?input=QUERY_SENTINEL", "/rpc/chess/list"],
  ])("sanitizes %s", (path, expected) => {
    expect(sanitizedRequestPath(`https://example.test${path}`)).toBe(expected);
  });
});

describe("requestLog", () => {
  it("logs the request ID, method, safe path, status and duration once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "request-123");
      await next();
    });
    app.use("*", requestLog);
    app.post("*", (c) => c.text("ok", 202));

    const res = await app.request("/api/auth/reset-password/PATH_SENTINEL?token=QUERY_SENTINEL", {
      method: "POST",
    });

    expect(res.status).toBe(202);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[request-123\] POST \/api\/auth\/reset-password\/\[redacted\] 202 \d+ms$/,
      ),
    );
  });
});
