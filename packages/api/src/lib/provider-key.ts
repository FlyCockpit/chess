import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";

/**
 * Users' own OpenRouter keys at rest (docs/deployment.md § Hosted chess for users).
 *
 * AES-256-GCM under `CHESS_PROVIDER_KEY_SECRET`, a fresh 96-bit nonce per seal, and
 * the owner's user id as associated data: a ciphertext copied onto another user's
 * row does not open. `keySecretId` (a fingerprint of the sealing secret, never the
 * secret) says which secret sealed a row, so a rotation can keep the previous one
 * in `CHESS_PROVIDER_KEY_SECRET_PREVIOUS` and re-seal rows as they are used.
 *
 * The plaintext key exists only in the server's callback (between OpenRouter's
 * exchange and the seal) and in the worker's memory for one match. It is never
 * returned by an API, logged, queued, archived or put in an error message.
 */

const AAD_PREFIX = "openrouter-key:v1:";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedProviderKey {
  keyCiphertext: Uint8Array<ArrayBuffer>;
  keyNonce: Uint8Array<ArrayBuffer>;
  keySecretId: string;
}

/** The fingerprint stored with a row: the first 16 hex of SHA-256 of the secret. */
export function providerKeySecretId(secretHex: string) {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex").slice(0, 16);
}

/** SHA-256 hex of a key: OpenRouter's key page is `openrouter.ai/keys/<hash>`. */
export function hashProviderKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

/** "sk-or-v1-…abcd": the four characters a user can match against OpenRouter's list. */
export function providerKeyHint(key: string) {
  return key.slice(-4);
}

const aad = (userId: string) => Buffer.from(AAD_PREFIX + userId, "utf8");
const bytes = (buffer: Buffer) => new Uint8Array(buffer);

export function sealProviderKey(userId: string, key: string, secretHex: string): SealedProviderKey {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secretHex, "hex"), nonce);
  cipher.setAAD(aad(userId));
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    keyCiphertext: bytes(sealed),
    keyNonce: bytes(nonce),
    keySecretId: providerKeySecretId(secretHex),
  };
}

/** The key, or null when the row does not open for this user with this secret. */
export function openProviderKey(
  userId: string,
  sealed: Pick<SealedProviderKey, "keyCiphertext" | "keyNonce">,
  secretHex: string,
): string | null {
  try {
    const data = Buffer.from(sealed.keyCiphertext);
    if (data.length <= TAG_BYTES || sealed.keyNonce.length !== NONCE_BYTES) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(secretHex, "hex"),
      Buffer.from(sealed.keyNonce),
    );
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** The configured secrets, current first. Empty when user keys cannot be stored here. */
export function providerKeySecrets(
  source: { CHESS_PROVIDER_KEY_SECRET?: string; CHESS_PROVIDER_KEY_SECRET_PREVIOUS?: string } = env,
) {
  return [source.CHESS_PROVIDER_KEY_SECRET, source.CHESS_PROVIDER_KEY_SECRET_PREVIOUS].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

const connectionKeySelect = {
  id: true,
  keyCiphertext: true,
  keyNonce: true,
  keySecretId: true,
  keyHash: true,
  status: true,
  updatedAt: true,
} satisfies Prisma.OpenRouterConnectionSelect;

/** What a user's stored connection amounts to right now. Never carries the key except when "ok". */
export type OwnerOpenRouterKey =
  /** No sealing secret is configured here: nothing can be opened, nothing is changed. */
  | { state: "unconfigured" }
  | { state: "missing" }
  /** The row is already marked invalid (OpenRouter refused it). */
  | { state: "inactive"; keyHash: string }
  /**
   * The row does not open here. When a configured secret sealed it but it fails to
   * open (or its hash does not match), it is marked invalid, so status and create ask
   * the user to reconnect instead of every match failing at claim time. When no
   * configured secret sealed it (a rolling rotation: another process may already hold
   * the new secret), it is only unreadable here and the row is left untouched.
   */
  | { state: "unreadable"; keyHash: string }
  | { state: "ok"; apiKey: string; keyHash: string };

/**
 * The owner's connected key, looked up by user id (for the worker: the match's
 * owner from the row, never the job) and opened with that user's id as associated
 * data. A row sealed with the previous secret is re-sealed with the current one.
 */
export async function openOwnerOpenRouterKey(userId: string): Promise<OwnerOpenRouterKey> {
  const secrets = providerKeySecrets();
  const current = secrets[0];
  if (!current) return { state: "unconfigured" };
  const row = await prisma.openRouterConnection.findUnique({
    where: { userId },
    select: connectionKeySelect,
  });
  if (!row) return { state: "missing" };
  if (row.status !== "active") return { state: "inactive", keyHash: row.keyHash };
  const secret = secrets.find((candidate) => row.keySecretId === providerKeySecretId(candidate));
  // Sealed with a secret this process does not hold: unreadable here, but another
  // process (mid-rotation) may open it, so the shared row is never invalidated for it.
  if (!secret) return { state: "unreadable", keyHash: row.keyHash };
  const apiKey = openProviderKey(userId, row, secret);
  if (!apiKey || hashProviderKey(apiKey) !== row.keyHash) {
    // Compare-and-set: a key reconnected (or re-sealed) meanwhile is left alone.
    try {
      await prisma.openRouterConnection.updateMany({
        where: {
          id: row.id,
          keyHash: row.keyHash,
          keySecretId: row.keySecretId,
          status: "active",
        },
        data: { status: "invalid", lastCheckedAt: new Date() },
      });
    } catch {
      // Best effort: the row stays unusable either way; the next read retries.
    }
    return { state: "unreadable", keyHash: row.keyHash };
  }
  if (secret !== current) {
    // Best effort: a failed re-seal leaves the row on the previous secret. The CAS
    // names the exact row version read, so a key reconnected in between (even by a
    // replica still sealing with the previous secret) is never overwritten.
    try {
      await prisma.openRouterConnection.updateMany({
        where: {
          id: row.id,
          keySecretId: row.keySecretId,
          keyHash: row.keyHash,
          updatedAt: row.updatedAt,
        },
        data: sealProviderKey(userId, apiKey, current),
      });
    } catch {
      // Left on the previous secret; the next load tries again.
    }
  }
  return { state: "ok", apiKey, keyHash: row.keyHash };
}

/**
 * The owner's usable key, or null when there is no active connection that opens; the
 * caller ends the match, it never falls back to the operator key.
 */
export async function loadOwnerOpenRouterKey(
  userId: string,
): Promise<{ apiKey: string; keyHash: string } | null> {
  const opened = await openOwnerOpenRouterKey(userId);
  return opened.state === "ok" ? { apiKey: opened.apiKey, keyHash: opened.keyHash } : null;
}

/**
 * OpenRouter refused the key (401): the row stays, marked invalid, so the user is
 * asked to reconnect. Compare-and-set on the hash: a key reconnected meanwhile stays.
 */
export async function markOpenRouterKeyInvalid(userId: string, keyHash: string) {
  await prisma.openRouterConnection.updateMany({
    where: { userId, keyHash, status: "active" },
    data: { status: "invalid", lastCheckedAt: new Date() },
  });
}
