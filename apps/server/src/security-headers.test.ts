import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders } from "./security-headers";

function buildApp(cspConnectSrc: string[] = ["'self'"]) {
  const app = new Hono();
  mountSecurityHeaders(app, {
    cspConnectSrc,
    themeInitCspHash: "'sha256-test'",
  });
  app.get("/some-page", (c) => c.text("page"));
  return app;
}

describe("mountSecurityHeaders", () => {
  it("serves the app CSP and security headers", async () => {
    const res = await buildApp().request("/some-page");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("allows neither 'wasm-unsafe-eval' nor 'unsafe-eval' in script-src", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    // Token-split assertions: a substring check would false-positive on
    // 'unsafe-eval' being contained inside 'wasm-unsafe-eval'.
    const tokens = csp.split(/\s+/).map((t) => t.replace(/;$/, ""));
    expect(tokens).not.toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-eval'");
  });

  it("restricts workers and images to the remaining sources", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    const workerSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("worker-src"));
    expect(workerSrc).toBeDefined();
    const tokens = (workerSrc ?? "").split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).not.toContain("blob:");
    // Script sources must also reject blob URLs.
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect((scriptSrc ?? "").split(/\s+/)).not.toContain("blob:");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("blob:");
    expect(csp).toContain("connect-src 'self'");
  });

  it("emits the configured frontend origin in connect-src", async () => {
    const res = await buildApp(["'self'", "https://app.example.com"]).request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https://app.example.com");
  });
});
