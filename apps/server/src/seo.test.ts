import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountCacheControl } from "./cache-control.js";

vi.mock("@cockpit-chess/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://app.example.com",
  },
  // seo.ts must route the display name through the env package
  // (resolveAppName), never process.env directly.
  resolveAppName: () => "TestApp",
}));

const { registerSeoRoutes } = await import("./seo.js");

const protectedRouteFragments = ["/admin", "/dashboard", "/settings", "/portal"];

describe("SEO routes", () => {
  it.each(["/robots.txt", "/sitemap.xml", "/llms.txt"])(
    "uses short public caching with revalidation for %s",
    async (path) => {
      const app = new Hono();
      mountCacheControl(app);
      registerSeoRoutes(app);
      for (const method of ["GET", "HEAD"]) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
      }
    },
  );
  it("discovers every localized legal page without exposing private utilities", async () => {
    const app = new Hono();
    registerSeoRoutes(app);
    const sitemap = await (await app.request("/sitemap.xml")).text();
    const llms = await (await app.request("/llms.txt")).text();
    for (const path of ["terms", "privacy", "licenses"]) {
      for (const locale of ["en-US", "es-MX"]) {
        expect(sitemap).toContain(`<loc>https://app.example.com/${locale}/${path}</loc>`);
        expect(sitemap).toContain(
          `hreflang="${locale}" href="https://app.example.com/${locale}/${path}"`,
        );
      }
      expect(llms).toContain(`https://app.example.com/en-US/${path}`);
    }
    for (const privatePath of ["/runner/claim", "/signup", "/device"]) {
      expect(sitemap).not.toContain(privatePath);
      expect(llms).not.toContain(privatePath);
    }
  });

  it("uses the configured canonical origin instead of request host headers", async () => {
    const app = new Hono();
    registerSeoRoutes(app);

    const sitemap = await app.request("/sitemap.xml", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });

    expect(sitemap.status).toBe(200);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("https://app.example.com/en-US");
    expect(sitemapBody).not.toContain("evil.example");
    for (const protectedPath of protectedRouteFragments) {
      expect(sitemapBody).not.toContain(protectedPath);
    }

    const robots = await app.request("/robots.txt", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(await robots.text()).toContain("Sitemap: https://app.example.com/sitemap.xml");
  });

  it("keeps protected routes out of llms.txt", async () => {
    const app = new Hono();
    registerSeoRoutes(app);

    const llms = await app.request("/llms.txt");

    expect(llms.status).toBe(200);
    const llmsBody = await llms.text();
    for (const protectedPath of protectedRouteFragments) {
      expect(llmsBody).not.toContain(protectedPath);
    }
  });

  it("renders the app name from the env package, not process.env", async () => {
    const app = new Hono();
    registerSeoRoutes(app);

    const llms = await app.request("/llms.txt");
    const llmsBody = await llms.text();
    expect(llmsBody).toContain("# TestApp");
    expect(llmsBody).not.toContain("process.env");
  });
});
