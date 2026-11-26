import { env } from "@cockpit-chess/env/web";

/**
 * The web half of "Connect OpenRouter" (apps/server/src/openrouter-routes.ts): the
 * choices offered before the redirect, starting the flow, and reading the result
 * the callback redirects back with. Kept apart from the settings page so the rules
 * are unit-tested without rendering it.
 */

/** Spend limits offered for the new key, in US dollars; null = no limit. */
export const LIMIT_CHOICES = [5, 10, 25, 50, null] as const;
export type LimitChoice = (typeof LIMIT_CHOICES)[number];
export const DEFAULT_LIMIT: LimitChoice = 10;
/** OpenRouter's `expiration` values we offer (its 1-hour option is too short to use). */
export const EXPIRY_CHOICES = [
  "7-days",
  "30-days",
  "90-days",
  "180-days",
  "1-year",
  "never",
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
export const DEFAULT_EXPIRY: ExpiryChoice = "90-days";

/** Why starting the flow failed, one per message the page shows. */
export type ConnectFailure =
  | "signIn"
  | "forbidden"
  | "twoFactor"
  | "rateLimited"
  | "unavailable"
  | "failed";

export class ConnectError extends Error {
  readonly reason: ConnectFailure;
  constructor(reason: ConnectFailure) {
    super(`OpenRouter connect failed: ${reason}`);
    this.name = "ConnectError";
    this.reason = reason;
  }
}

/** The server's `{ error }` code decides where one HTTP status covers several causes. */
export function connectFailureFor(status: number, code?: unknown): ConnectFailure {
  if (status === 401) return "signIn";
  if (status === 403) {
    if (code === "two-factor") return "twoFactor";
    if (code === "disabled") return "unavailable";
    if (code === "unverified") return "forbidden";
    return "failed";
  }
  if (status === 429) return "rateLimited";
  if (status === 404 || status === 409 || status === 503) return "unavailable";
  return "failed";
}

/**
 * Asks the server for OpenRouter's consent URL (the server keeps the PKCE verifier and
 * binds the state to this session and browser). Only an http(s) URL is ever followed.
 */
export async function startOpenRouterConnect(
  input: { limitUsd: LimitChoice; expiration: ExpiryChoice; lang: string },
  options: { serverUrl?: string; fetch?: typeof fetch } = {},
): Promise<string> {
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    // The API origin RPC uses (VITE_SERVER_URL in a cross-origin deployment), not the page's.
    const origin = options.serverUrl ?? env.VITE_SERVER_URL ?? "";
    response = await request(`${origin}/api/openrouter/connect`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ConnectError("failed");
  }
  if (!response.ok) {
    const code = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body ? body.error : undefined,
      )
      .catch(() => undefined);
    throw new ConnectError(connectFailureFor(response.status, code));
  }
  let url: unknown;
  try {
    url = ((await response.json()) as { url?: unknown }).url;
  } catch {
    throw new ConnectError("failed");
  }
  if (typeof url !== "string") throw new ConnectError("failed");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
  } catch {
    throw new ConnectError("failed");
  }
  return url;
}

/** The callback's result codes (`?error=`); anything else reads as unknown. */
export const CALLBACK_ERRORS = [
  "denied",
  "expired",
  "mismatch",
  "exchange",
  "verify",
  "unavailable",
  "disabled",
] as const;
type CallbackError = (typeof CALLBACK_ERRORS)[number] | "unknown";
export type CallbackNotice = { kind: "connected" } | { kind: "error"; code: CallbackError };

export function callbackNotice(search: {
  connected?: unknown;
  error?: unknown;
}): CallbackNotice | null {
  if (search.error !== undefined && search.error !== "") {
    const code = CALLBACK_ERRORS.find((value) => value === search.error) ?? "unknown";
    return { kind: "error", code };
  }
  if (search.connected === "1" || search.connected === 1) return { kind: "connected" };
  return null;
}

/** The route's search, kept to the two values the callback may send. */
export function parseOpenRouterSearch(search: Record<string, unknown>): {
  connected?: "1";
  error?: string;
} {
  const out: { connected?: "1"; error?: string } = {};
  if (search.connected === "1" || search.connected === 1) out.connected = "1";
  if (typeof search.error === "string" && /^[a-z-]{1,32}$/.test(search.error))
    out.error = search.error;
  return out;
}

/** OpenRouter's page for one key (its hash is not secret) and that key's activity. */
export const manageKeyUrl = (keyHash: string) =>
  `https://openrouter.ai/keys/${encodeURIComponent(keyHash)}`;
export const keyActivityUrl = (keyHash: string) =>
  `https://openrouter.ai/logs?api_key_hash=${encodeURIComponent(keyHash)}`;
