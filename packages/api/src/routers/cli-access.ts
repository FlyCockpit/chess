import { auth } from "@cockpit-chess/auth";
import { CLI_INSTALL_AUTH_SCHEME } from "@cockpit-chess/config/cli";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { createCliInstallToken } from "../lib/cli-install-token";
import { isCliReleaseConfigured } from "../lib/cli-release";
import { entityId } from "../lib/schemas";

/**
 * The web side of companion-CLI access, mounted on the cookie surface (`/rpc`)
 * and used by /$lang/settings/cli. The CLI itself never calls this router; it
 * talks to `cliRouter` on `/api/cli/rpc`. See packages/api/src/routers/cli.ts.
 *
 * Everything here is `protectedProcedure`: minting a credential is exactly the
 * moment the forced-2FA policy must already be satisfied.
 */

/** Soft cap per user. Keeps `list` bounded without pagination UI. */
export const MAX_API_KEYS_PER_USER = 25;

/** The only lifetimes offered. No "never": a forgotten key should die on its own. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

/** The client-facing shape. The hash (`key`) and owner never leave the server. */
const apiKeySelect = {
  id: true,
  name: true,
  start: true,
  createdAt: true,
  expiresAt: true,
  lastRequest: true,
} satisfies Prisma.ApiKeySelect;

export const cliAccessRouter = {
  /**
   * A fresh copy-paste install command. Minted on every call (the page
   * refetches on mount) so the embedded token is always newly issued and
   * expires 15 minutes later.
   */
  installCommand: protectedProcedure.handler(({ context }) => {
    if (!isCliReleaseConfigured()) {
      return { available: false as const };
    }
    const { token, expiresAt } = createCliInstallToken(context.session.user.id);
    const base = `${env.BETTER_AUTH_URL}/api/cli`;
    // The token rides in a header, never the URL, so access logs (the app's
    // and any reverse proxy's) never record it.
    const header = `Authorization: ${CLI_INSTALL_AUTH_SCHEME} ${token}`;
    return {
      available: true as const,
      expiresAt,
      unix: `curl -fsSL -H "${header}" "${base}/install.sh" | sh`,
      windows: `irm -Headers @{ Authorization = "${CLI_INSTALL_AUTH_SCHEME} ${token}" } "${base}/install.ps1" | iex`,
    };
  }),

  apiKeys: {
    list: protectedProcedure.handler(async ({ context }) => {
      return prisma.apiKey.findMany({
        where: { referenceId: context.session.user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // pagination:audited — bounded by MAX_API_KEYS_PER_USER, which create
        // enforces after its insert (so concurrent creates cannot overshoot it)
        take: MAX_API_KEYS_PER_USER,
        select: apiKeySelect,
      });
    }),

    /** Returns the plaintext key exactly once; only its hash is stored. */
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(64),
          expiresInDays: z.union(API_KEY_EXPIRY_DAYS.map((days) => z.literal(days))),
        }),
      )
      .handler(async ({ input, context }) => {
        const userId = context.session.user.id;
        const existing = await prisma.apiKey.count({ where: { referenceId: userId } });
        if (existing >= MAX_API_KEYS_PER_USER) {
          throw new ORPCError("BAD_REQUEST", {
            message: `You can have at most ${MAX_API_KEYS_PER_USER} API keys. Revoke one first.`,
          });
        }
        // Server-side call (no headers): `userId` comes from the verified
        // session, never from input.
        const created = await auth.api.createApiKey({
          body: {
            name: input.name,
            expiresIn: input.expiresInDays * 24 * 60 * 60,
            userId,
          },
        });
        // The count above and the insert are separate steps, so concurrent
        // creates can each pass it. Recount and undo our own insert if it
        // overshot: the cap then always holds, which is what keeps the bounded
        // `list` complete (this procedure is the only way to mint a key — the
        // plugin's HTTP routes are 404-gated).
        const after = await prisma.apiKey.count({ where: { referenceId: userId } });
        if (after > MAX_API_KEYS_PER_USER) {
          await prisma.apiKey.deleteMany({ where: { id: created.id, referenceId: userId } });
          throw new ORPCError("BAD_REQUEST", {
            message: `You can have at most ${MAX_API_KEYS_PER_USER} API keys. Revoke one first.`,
          });
        }
        return {
          id: created.id,
          name: created.name,
          start: created.start,
          expiresAt: created.expiresAt,
          key: created.key,
        };
      }),

    revoke: protectedProcedure
      .input(z.object({ id: entityId }))
      .handler(async ({ input, context }) => {
        // Owner scope in the query: a foreign id deletes nothing and reads as
        // NOT_FOUND, never FORBIDDEN (no existence oracle).
        const { count } = await prisma.apiKey.deleteMany({
          where: { id: input.id, referenceId: context.session.user.id },
        });
        if (count === 0) throw new ORPCError("NOT_FOUND", { message: "API key not found" });
        return { success: true };
      }),
  },
};
