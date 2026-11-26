import { createHash, randomBytes } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";
import { z } from "zod";
import {
  hashProviderKey,
  providerKeyHint,
  providerKeySecrets,
  sealProviderKey,
} from "./provider-key";

/**
 * Talking to OpenRouter about a user's own key: the OAuth PKCE exchange
 * (apps/server/src/openrouter-routes.ts), key introspection (`GET /api/v1/key`) for
 * the settings page, and storing the sealed key. Every call goes to the fixed
 * `OPENROUTER_ORIGIN` (https://openrouter.ai unless a test stack points it at a
 * mock), never to a caller-supplied URL. No function here logs, returns or throws
 * anything that contains the key, the code or the verifier: errors are fixed
 * `OpenRouterAccountError` codes.
 */

const TIMEOUT_MS = 10_000;
/** Bounds what is read from OpenRouter's responses. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type OpenRouterAccountErrorCode =
  /** The code or verifier was refused (403), or the code expired. */
  | "exchange"
  /** OpenRouter refused the key (401/403): revoked, expired or disabled. */
  | "rejected"
  /** OpenRouter was unreachable, slow, or answered something unexpected. */
  | "unavailable";

export class OpenRouterAccountError extends Error {
  constructor(readonly code: OpenRouterAccountErrorCode) {
    super(`OpenRouter request failed: ${code}`);
    this.name = "OpenRouterAccountError";
  }
}

/** The PKCE expirations OpenRouter's consent page accepts and the app offers. */
export const OPENROUTER_EXPIRATIONS = [
  "1-day",
  "7-days",
  "30-days",
  "90-days",
  "180-days",
  "1-year",
  "never",
] as const;
export type OpenRouterExpiration = (typeof OPENROUTER_EXPIRATIONS)[number];

export const base64url = (buffer: Buffer) => buffer.toString("base64url");
export const newPkceSecret = () => base64url(randomBytes(32));
export const pkceChallenge = (verifier: string) =>
  base64url(createHash("sha256").update(verifier).digest());

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new OpenRouterAccountError("unavailable");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenRouterAccountError("unavailable");
  }
}

async function call(
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await fetcher(`${env.OPENROUTER_ORIGIN}${path}`, {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new OpenRouterAccountError("unavailable");
  }
}

const exchangeSchema = z.object({ key: z.string().min(16).max(512) });

/** `POST /api/v1/auth/keys`: trades the one-time code (plus our verifier) for the user's key. */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await call(
    "/api/v1/auth/keys",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    },
    fetcher,
  );
  if (response.status === 400 || response.status === 401 || response.status === 403)
    throw new OpenRouterAccountError("exchange");
  if (!response.ok) throw new OpenRouterAccountError("unavailable");
  const parsed = exchangeSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new OpenRouterAccountError("unavailable");
  return parsed.data.key;
}

const usd = z.number().finite().nullish();
const keyInfoSchema = z.object({
  data: z.object({
    label: z.string().max(200).nullish(),
    limit: usd,
    limit_remaining: usd,
    usage: usd,
    usage_daily: usd,
    expires_at: z.string().max(64).nullish(),
  }),
});

export interface OpenRouterKeyInfo {
  label: string | null;
  limitMicros: number | null;
  limitRemainingMicros: number | null;
  usageMicros: number | null;
  usageDailyMicros: number | null;
  expiresAt: Date | null;
}

const micros = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.max(0, Math.round(value * 1_000_000));

/** `GET /api/v1/key` with the key itself: its label, limit, usage and expiry. */
export async function fetchOpenRouterKeyInfo(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpenRouterKeyInfo> {
  const response = await call(
    "/api/v1/key",
    { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
    fetcher,
    signal,
  );
  if (response.status === 401 || response.status === 403)
    throw new OpenRouterAccountError("rejected");
  if (!response.ok) throw new OpenRouterAccountError("unavailable");
  const parsed = keyInfoSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new OpenRouterAccountError("unavailable");
  const data = parsed.data.data;
  const expires = data.expires_at ? new Date(data.expires_at) : null;
  return {
    label: data.label ?? null,
    limitMicros: micros(data.limit),
    limitRemainingMicros: micros(data.limit_remaining),
    usageMicros: micros(data.usage),
    usageDailyMicros: micros(data.usage_daily),
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
  };
}

/** Seals and stores a verified key, replacing any earlier one of the same user. */
export async function saveOpenRouterConnection(
  userId: string,
  apiKey: string,
  info: OpenRouterKeyInfo,
) {
  const [secret] = providerKeySecrets();
  if (!secret) throw new OpenRouterAccountError("unavailable");
  const data = {
    ...sealProviderKey(userId, apiKey, secret),
    keyHash: hashProviderKey(apiKey),
    keyHint: providerKeyHint(apiKey),
    label: info.label,
    limitMicros: info.limitMicros === null ? null : BigInt(info.limitMicros),
    expiresAt: info.expiresAt,
    status: "active",
    lastCheckedAt: new Date(),
  } satisfies Prisma.OpenRouterConnectionUncheckedUpdateInput;
  await prisma.openRouterConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: { id: true },
  });
}

/**
 * Whether this server lets the caller connect and bill their own OpenRouter key:
 * hosted inference on, a sealing secret configured, and user matches opened by the
 * operator (admins may connect whenever hosted inference is on).
 */
export function ownOpenRouterAvailable(isAdmin: boolean) {
  return (
    env.CHESS_HOSTED_ENABLED &&
    providerKeySecrets().length > 0 &&
    (env.CHESS_USER_MATCHES_ENABLED || isAdmin)
  );
}
