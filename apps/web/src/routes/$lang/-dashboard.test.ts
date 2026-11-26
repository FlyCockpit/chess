import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  redirect: (options: unknown) => ({ redirect: options }),
}));

const { Route } = await import("./dashboard");
const { safeRedirectTo } = await import("@/utils/safe-redirect");

describe("/$lang/dashboard", () => {
  // The welcome dashboard is gone: the arena is the home for everyone.
  it("is only a redirect to the arena, keeping the locale", () => {
    const { beforeLoad, component } = (
      Route as unknown as {
        options: { beforeLoad: (ctx: unknown) => void; component?: unknown };
      }
    ).options;
    expect(component).toBeUndefined();
    let thrown: unknown;
    try {
      beforeLoad({ params: { lang: "es-MX" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual({
      redirect: { to: "/$lang", params: { lang: "es-MX" }, replace: true },
    });
  });
});

describe("post-sign-in target", () => {
  it("falls back to the arena, never to the old dashboard", () => {
    expect(safeRedirectTo(undefined, "en-US")).toBe("/en-US");
    expect(safeRedirectTo("https://evil.example/", "en-US")).toBe("/en-US");
    expect(safeRedirectTo("/en-US/login", "en-US")).toBe("/en-US");
    expect(safeRedirectTo("/en-US/?tab=studio", "en-US")).toBe("/en-US/?tab=studio");
  });
});
