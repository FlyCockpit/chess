import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

// Exercise the cross-package URL contract, not just the client-side parser.
import { withVerificationCallback } from "../../../../packages/auth/src/verification-callback";
import { parseVerifyEmailSearch, verificationCallback } from "./verify-email-search";

/**
 * These cases go through `defaultParseSearch` — the router's ACTUAL parser —
 * rather than hand-built objects. That is the whole point: the original bug was
 * that `?ok=1` reaches `validateSearch` as the number 1, and a test asserting
 * on the raw string `"?ok=1"` (as the verification-callback suite does) cannot
 * see it. Anything that stubs the parser reintroduces the blind spot.
 */
const parseUrl = (search: string) => defaultParseSearch(search) as Record<string, unknown>;
const fromUrl = (search: string) => parseVerifyEmailSearch(parseUrl(search));

describe("parseVerifyEmailSearch", () => {
  it("recognizes the ?ok=1 marker buildCallback actually emits", () => {
    // Regression: JSON.parse("1") === 1, so this arrives as a number.
    expect(parseUrl("?ok=1").ok).toBe(1);
    expect(fromUrl("?ok=1")).toEqual({ ok: true, error: undefined, redirectTo: undefined });
  });

  it("accepts the other spellings of the marker", () => {
    expect(fromUrl("?ok=true").ok).toBe(true);
    // Quoted in the URL, so JSON.parse yields the string "1".
    expect(fromUrl('?ok="1"').ok).toBe(true);
  });

  it("treats a bare visit as unknown, not success", () => {
    // A guard redirect arrives with no params; rendering it as success would
    // tell an unverified user their address is already confirmed.
    expect(fromUrl("")).toEqual({ ok: undefined, error: undefined, redirectTo: undefined });
    expect(fromUrl("?lang=en-US")).toEqual({
      ok: undefined,
      error: undefined,
      redirectTo: undefined,
    });
  });

  it("surfaces an error code as a string", () => {
    expect(fromUrl("?error=TOKEN_EXPIRED")).toEqual({
      ok: undefined,
      error: "TOKEN_EXPIRED",
      redirectTo: undefined,
    });
  });

  it("keeps the error when Better-Auth appends it to the success callback", () => {
    // The real failure shape: our ?ok=1 callback with &error= tacked on.
    expect(fromUrl("?ok=1&error=TOKEN_EXPIRED")).toEqual({
      ok: true,
      error: "TOKEN_EXPIRED",
      redirectTo: undefined,
    });
  });

  it("ignores values that are not a recognized marker", () => {
    expect(fromUrl("?ok=0").ok).toBeUndefined();
    expect(fromUrl("?ok=false").ok).toBeUndefined();
    expect(fromUrl("?ok=maybe").ok).toBeUndefined();
    expect(fromUrl("?error=1").error).toBeUndefined();
  });
});

describe("verification destination", () => {
  it.each(["en-US", "es-MX"])("survives the server rewrite with URL punctuation in %s", (lang) => {
    const destination = `/${lang}/?tab=studio&title=!'()*~+ space#match~1`;
    const verificationUrl = new URL("https://api.example.test/api/auth/verify-email?token=fixture");
    verificationUrl.searchParams.set("callbackURL", verificationCallback(lang, destination));
    const mailedUrl = new URL(
      withVerificationCallback(verificationUrl.href, lang, "https://app.example.test"),
    );
    const callback = new URL(mailedUrl.searchParams.get("callbackURL")!);
    expect(callback.origin).toBe("https://app.example.test");
    expect(callback.pathname).toBe(`/${lang}/verify-email`);
    expect(fromUrl(callback.search)).toEqual({
      ok: true,
      error: undefined,
      redirectTo: destination,
    });
  });
  it.each(["en-US", "es-MX"])(
    "keeps the Studio query and hash in %s through the email callback",
    (lang) => {
      const destination = `/${lang}/?tab=studio&game=fixture#match`;
      const callback = new URL(verificationCallback(lang, destination), "https://app.example.test");
      expect(callback.pathname).toBe(`/${lang}/verify-email`);
      expect(fromUrl(callback.search)).toEqual({
        ok: true,
        error: undefined,
        redirectTo: destination,
      });
      callback.searchParams.set("error", "TOKEN_EXPIRED");
      expect(fromUrl(callback.search)).toEqual({
        ok: true,
        error: "TOKEN_EXPIRED",
        redirectTo: destination,
      });
    },
  );

  it.each([
    undefined,
    "https://evil.example/",
    "//evil.example/",
    "/en-US/login",
    "/en-US/signup",
    "/es-MX/?tab=studio",
  ])("uses the existing safe home fallback for %s", (target) => {
    const callback = new URL(verificationCallback("en-US", target), "https://app.example.test");
    expect(fromUrl(callback.search).redirectTo).toBe("/en-US");
  });

  it("ignores non-string destinations from the router parser", () => {
    expect(fromUrl("?redirectTo=1").redirectTo).toBeUndefined();
    expect(fromUrl("?redirectTo=true").redirectTo).toBeUndefined();
  });
});
