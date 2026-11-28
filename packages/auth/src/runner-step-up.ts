import { createHmac, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";
import { auth, passwordPepper } from "./index.js";

export const runnerStepUpSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("password"), password: z.string().min(1).max(1024) }),
  z.strictObject({ method: z.literal("totp"), code: z.string().regex(/^\d{6}$/) }),
]);
export type RunnerStepUp = z.infer<typeof runnerStepUpSchema>;

/** Generated and imported Better-Auth TOTP secrets use the same public OTP primitive. */
function importedSecret(secret: string): string | Uint8Array {
  if (!secret.startsWith("base32:")) return secret;
  const encoded = secret.slice(7).replace(/=+$/, "").toUpperCase();
  if (!/^[A-Z2-7]{1,256}$/.test(encoded) || ![0, 2, 4, 5, 7].includes(encoded.length % 8))
    throw new Error("INVALID");
  let value = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0) throw new Error("INVALID");
  return Uint8Array.from(bytes);
}

/** RFC 4226/6238 for imported binary keys; never reinterpret random bytes as UTF-8. */
function importedTotp(secret: Uint8Array): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** No session cookie, trust-device shortcut, credential or raw error leaves this function. */
export async function verifyRunnerLimitStepUp(
  verification: RunnerStepUp,
  credential: { password?: string | null; totpSecret?: string | null },
): Promise<boolean> {
  try {
    if (verification.method === "password") {
      return (
        !!credential.password &&
        (await passwordPepper.verify({
          hash: credential.password,
          password: verification.password,
        }))
      );
    }
    if (!credential.totpSecret) return false;
    const context = await auth.$context;
    const secret = importedSecret(
      await symmetricDecrypt({ key: context.secretConfig, data: credential.totpSecret }),
    );
    // This is the configured Better-Auth server-only OTP primitive. Requiring the
    // current code avoids inventing a second OTP window or bypassing an expired code.
    const code =
      typeof secret === "string"
        ? (await auth.api.generateTOTP({ body: { secret } })).code
        : importedTotp(secret);
    const actual = Buffer.from(verification.code);
    const wanted = Buffer.from(code);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}
