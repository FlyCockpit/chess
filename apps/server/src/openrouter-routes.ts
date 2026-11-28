import { createHash, timingSafeEqual } from "node:crypto";
import { checkAdminAuthority, isTwoFactorPolicySatisfied } from "@cockpit-chess/api";
import {
  exchangeOpenRouterCode,
  fetchOpenRouterKeyInfo,
  newPkceSecret,
  OPENROUTER_EXPIRATIONS,
  OpenRouterAccountError,
  ownOpenRouterAvailable,
  pkceChallenge,
  saveOpenRouterConnection,
} from "@cockpit-chess/api/lib/openrouter-account";
import type { Session } from "@cockpit-chess/auth";
import { dispatchForActiveOwner, isOwnerActive } from "@cockpit-chess/auth/account-deletion";
import { DEFAULT_LOCALE, isSupportedLocale } from "@cockpit-chess/config/locales";
import type { Context, Env, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

/**
 * "Connect OpenRouter": OpenRouter's OAuth PKCE flow, which gives the server a key
 * that belongs to the user and bills their credits. No client registration exists;
 * the app is identified by its callback. See docs/deployment.md § Hosted chess for users
 *
 *   POST /api/openrouter/connect   { limitUsd, expiration, lang }  → { url }
 *   GET  /api/openrouter/callback  ?code&state                     → 303 to settings
 *
 * The rules, each enforced here:
 *   - Both need the cookie session (sessionMiddleware); start also needs the
 *     `x-csrf-token: orpc` header /rpc requires, a verified email and the 2FA policy.
 *   - `state` (256 random bits) is single use: its record lives in Valkey for 10
 *     minutes under a hash of the state and is taken with GETDEL. The record names
 *     the user who started; the callback must come from that same signed-in user.
 *   - A short-lived HttpOnly, SameSite=Lax cookie holds another hash of the state,
 *     so the callback must also arrive in the browser that started the flow.
 *   - PKCE S256: the verifier never leaves the server; the code exchange happens
 *     server-side against the fixed OPENROUTER_ORIGIN, then `GET /api/v1/key` verifies
 *     the new key before it is sealed and stored (lib/openrouter-account.ts).
 *   - The key, code, verifier and state never appear in a response, a redirect, a log
 *     or an error: failures redirect with a fixed reason code, and the request log
 *     records the path without its query (request-log.ts).
 */

export const OPENROUTER_CONNECT_PATH = "/api/openrouter/connect";
export const OPENROUTER_CALLBACK_PATH = "/api/openrouter/callback";
const OPENROUTER_STATE_TTL_SECONDS = 600;
const STATE_KEY = "cockpit-chess:openrouter-oauth:";

/** Why a connect attempt failed, as the settings page's `?error=` (it says what to do). */
export type OpenRouterConnectError =
  | "denied"
  | "expired"
  | "used"
  | "mismatch"
  | "exchange"
  | "verify"
  | "unavailable"
  | "disabled";

interface OpenRouterStateStore {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
}

export interface OpenRouterRouteOptions {
  store: OpenRouterStateStore;
  /** `BETTER_AUTH_URL`: the public origin OpenRouter sends the browser back to. */
  publicOrigin: string;
  /**
   * Where the web app lives (`CORS_ORIGIN ?? BETTER_AUTH_URL`, as the CLI and auth
   * links use), so a separate-origin deployment lands back on the web app, not on
   * this API host. Omitted or equal to `publicOrigin`: a same-origin relative redirect.
   */
  webOrigin?: string;
  /** `OPENROUTER_ORIGIN`: where the consent page lives. */
  openRouterOrigin: string;
  fetch?: typeof fetch;
  audit?: (entry: { event: "openrouter.connect"; outcome: string; requestId: string }) => void;
}

const startSchema = z.object({
  limitUsd: z.number().min(0.5).max(1000).nullable(),
  expiration: z.enum(OPENROUTER_EXPIRATIONS),
  lang: z.string().max(16),
});
const recordSchema = z.object({
  userId: z.string().min(1),
  verifier: z.string().min(43).max(128),
  cookie: z.string().length(64),
  lang: z.string().max(16),
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stateKey = (state: string) => `${STATE_KEY}${sha256(`state:${state}`)}`;
const cookieValue = (state: string) => sha256(`cookie:${state}`);
const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const localeOf = (lang: unknown) => (isSupportedLocale(lang) ? lang : DEFAULT_LOCALE);

function defaultAudit(entry: { event: string; outcome: string; requestId: string }) {
  console.info("[audit]", JSON.stringify(entry));
}

export function mountOpenRouterRoutes<E extends Env>(
  app: Hono<E>,
  options: OpenRouterRouteOptions,
) {
  const fetcher = options.fetch ?? fetch;
  const audit = options.audit ?? defaultAudit;
  const secure = new URL(options.publicOrigin).protocol === "https:";
  // `__Host-` needs Secure, so a plain-http dev origin uses an unprefixed name.
  const cookieName = secure ? "__Host-or_oauth" : "or_oauth";
  const callbackUrl = `${options.publicOrigin}${OPENROUTER_CALLBACK_PATH}`;
  const returnOrigin =
    options.webOrigin && new URL(options.webOrigin).origin !== new URL(options.publicOrigin).origin
      ? new URL(options.webOrigin).origin
      : "";
  const record = (c: Context, outcome: string) =>
    audit({
      event: "openrouter.connect",
      outcome,
      requestId: (c.get("requestId") as string | undefined) ?? "-",
    });
  const sessionOf = (c: Context) => (c.get("session") as Session | null | undefined) ?? null;
  const isAdmin = async (session: Session) => (await checkAdminAuthority(session)).ok;

  app.post(OPENROUTER_CONNECT_PATH, async (c) => {
    const session = sessionOf(c);
    if (!session?.user || !(await isOwnerActive(session.user.id))) {
      record(c, "unauthenticated");
      return c.json({ error: "unauthenticated" }, 401);
    }
    if (c.req.header("x-csrf-token") !== "orpc") {
      record(c, "csrf");
      return c.json({ error: "forbidden" }, 403);
    }
    if (!session.user.emailVerified) {
      record(c, "unverified");
      return c.json({ error: "unverified" }, 403);
    }
    if (!(await isTwoFactorPolicySatisfied(session.user))) {
      record(c, "two-factor");
      return c.json({ error: "two-factor" }, 403);
    }
    if (!ownOpenRouterAvailable(await isAdmin(session))) {
      record(c, "disabled");
      return c.json({ error: "disabled" }, 403);
    }
    let body: z.infer<typeof startSchema>;
    try {
      body = startSchema.parse(await c.req.json());
    } catch {
      record(c, "invalid_request");
      return c.json({ error: "invalid_request" }, 400);
    }
    const state = newPkceSecret();
    const verifier = newPkceSecret();
    const cookie = cookieValue(state);
    try {
      await options.store.set(
        stateKey(state),
        JSON.stringify({
          userId: session.user.id,
          verifier,
          cookie,
          lang: localeOf(body.lang),
        } satisfies z.infer<typeof recordSchema>),
        "EX",
        OPENROUTER_STATE_TTL_SECONDS,
      );
    } catch {
      record(c, "store_unavailable");
      return c.json({ error: "unavailable" }, 503);
    }
    setCookie(c, cookieName, cookie, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: OPENROUTER_STATE_TTL_SECONDS,
    });
    const url = new URL("/auth", options.openRouterOrigin);
    url.searchParams.set("callback_url", callbackUrl);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("key_label", `Cockpit Chess (${new URL(options.publicOrigin).host})`);
    if (body.limitUsd !== null) url.searchParams.set("limit", String(body.limitUsd));
    url.searchParams.set("expiration", body.expiration);
    record(c, "started");
    return c.json({ url: url.toString() });
  });

  app.get(OPENROUTER_CALLBACK_PATH, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const presented = getCookie(c, cookieName);
    deleteCookie(c, cookieName, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
    let lang: string = DEFAULT_LOCALE;
    const done = (outcome: OpenRouterConnectError | "connected") => {
      record(c, outcome);
      const query = outcome === "connected" ? "connected=1" : `error=${outcome}`;
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      // Fixed path, allowlisted locale, configured origin: never an open redirect.
      return c.redirect(`${returnOrigin}/${lang}/settings/openrouter?${query}`, 303);
    };
    // Take the state first, whatever else is wrong: it must never be usable twice.
    let stored: z.infer<typeof recordSchema> | null = null;
    let used = false;
    if (state && state.length <= 128) {
      let raw: string | null;
      try {
        const key = stateKey(state);
        raw = await options.store.getdel(key);
        if (!raw) used = (await options.store.get(`${key}:used`)) !== null;
      } catch {
        return done("unavailable");
      }
      try {
        const parsed = raw ? recordSchema.safeParse(JSON.parse(raw)) : null;
        stored = parsed?.success ? parsed.data : null;
      } catch {
        stored = null;
      }
      if (stored) {
        try {
          await options.store.set(`${stateKey(state)}:used`, "1", "EX", 3600);
        } catch {
          return done("unavailable");
        }
        lang = localeOf(stored.lang);
      }
    }
    // OpenRouter echoes no state when the user declines.
    if (!code) return done("denied");
    if (!stored) return done(used ? "used" : "expired");
    const session = sessionOf(c);
    if (
      !session?.user ||
      session.user.id !== stored.userId ||
      !(await isOwnerActive(session.user.id)) ||
      !presented ||
      !sameHex(presented, stored.cookie)
    )
      return done("mismatch");
    if (!ownOpenRouterAvailable(await isAdmin(session))) return done("disabled");
    if (code.length > 512) return done("exchange");
    // The state/session checks may have awaited other storage. Each outbound
    // request is admitted under the same owner lock as the deletion tombstone.
    // Saving below takes its own short lock after these network guards release.
    const ownerFetch: typeof fetch = (input, init) =>
      dispatchForActiveOwner(session.user.id, () => fetcher(input, init));
    try {
      const key = await exchangeOpenRouterCode(code, stored.verifier, ownerFetch);
      let info: Awaited<ReturnType<typeof fetchOpenRouterKeyInfo>>;
      try {
        info = await fetchOpenRouterKeyInfo(key, ownerFetch);
      } catch (error) {
        return done(
          error instanceof OpenRouterAccountError && error.code === "unavailable"
            ? "unavailable"
            : "verify",
        );
      }
      await saveOpenRouterConnection(session.user.id, key, info);
      return done("connected");
    } catch (error) {
      if (error instanceof OpenRouterAccountError && error.code === "exchange")
        return done("exchange");
      // Never the error itself: a driver message could quote what was being written.
      return done("unavailable");
    }
  });
}
