import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@cockpit-chess/env/server";

// Short-lived, stateless tokens embedded in the copy-paste install command
// (`curl …/api/cli/install.sh?token=… | sh`). The signed-in settings page mints
// a fresh one on every load; the install script presents it to the download
// endpoints. It authorizes downloading the CLI binary and nothing else — it is
// not a session and is never accepted by an oRPC procedure.
//
// Stateless on purpose: there is nothing to sweep, and the 15-minute expiry
// bounds the damage of one leaking into shell history or a screenshot. The
// download endpoints still re-check that the user exists and is not banned.
// See packages/api/src/routers/cli.ts

export const CLI_INSTALL_TOKEN_TTL_MS = 15 * 60 * 1000;

const VERSION = "v1";

// Domain-separated from every other use of BETTER_AUTH_SECRET: a value signed
// here can never verify as a Better-Auth cookie signature or vice versa.
function signingKey(): Buffer {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update("cli-install-token:v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function createCliInstallToken(
  userId: string,
  now: number = Date.now(),
): { token: string; expiresAt: Date } {
  const expiresAt = now + CLI_INSTALL_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: expiresAt })).toString("base64url");
  return {
    token: `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`)}`,
    expiresAt: new Date(expiresAt),
  };
}

/** The user id the token was minted for, or `null` when malformed, forged, or expired. */
export function verifyCliInstallToken(token: string, now: number = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== VERSION) return null;

  const expected = Buffer.from(sign(`${version}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof (claims as { u?: unknown }).u !== "string" ||
    typeof (claims as { e?: unknown }).e !== "number"
  ) {
    return null;
  }
  const { u, e } = claims as { u: string; e: number };
  if (e <= now) return null;
  return u;
}
