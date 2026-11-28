import { auth } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import {
  CliCredentialSessionRevokedError,
  lockCliCredentials,
  mintCliCredentialForSession,
  withCliCredentialLockSlot,
} from "@cockpit-chess/auth/device-redemption-lock";
import {
  RunnerClaimNotFoundError,
  runnerClaimService,
  runnerClaimTokenSchema,
} from "@cockpit-chess/auth/runner-claim";
import {
  RunnerLimitsError,
  runnerLimitsProofRequestSchema,
  runnerLimitsService,
  runnerLimitsSetRequestSchema,
} from "@cockpit-chess/auth/runner-limits";
import {
  RunnerMachineForbiddenError,
  RunnerMachineInputError,
  RunnerMachineLimitError,
  RunnerMachineSessionRevokedError,
  revokeRunnerMachinesInTransaction,
} from "@cockpit-chess/auth/runner-machine";
import { CLI_INSTALL_AUTH_SCHEME } from "@cockpit-chess/config/cli";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "../context";
import { protectedProcedure } from "../index";
import { createCliInstallToken } from "../lib/cli-install-token";
import { isCliReleaseConfigured } from "../lib/cli-release";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
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

const runnerSelect = {
  id: true,
  displayName: true,
  credentialPrefix: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastSeenAt: true,
} satisfies Prisma.RunnerMachineSelect;

/** Inventory and revocation share reset's lock and recheck browser authority in that transaction. */
async function withRunnerBrowserSession<T>(
  context: Context & { session: NonNullable<Context["session"]> },
  run: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
): Promise<T> {
  if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
  const userId = context.session.user.id;
  return withCliCredentialLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        await lockCliCredentials(userId, tx);
        const live = await tx.session.findFirst({
          where: {
            id: context.session.session.id,
            userId,
            expiresAt: { gt: new Date() },
            origin: "sign-in",
            impersonatedBy: null,
          },
          select: { user: { select: { banned: true, banExpires: true } } },
        });
        if (!live || isUserBanned(live.user)) throw new ORPCError("UNAUTHORIZED");
        return run(tx, userId);
      },
      { timeout: 30_000 },
    ),
  );
}

const limitProofBudget = createProcedureBudget({
  keyPrefix: "rl:runner-limit-proof",
  points: 5,
  durationSeconds: 300,
  failClosed: true,
  overBudgetMessage: () => "Runner verification budget exhausted",
  unavailableMessage: "Runner verification unavailable",
  unavailableLog: "Runner limit proof budget unavailable",
});
const limitWriteBudget = createProcedureBudget({
  keyPrefix: "rl:runner-limit-write",
  points: 30,
  durationSeconds: 300,
  failClosed: true,
  overBudgetMessage: () => "Runner limit update budget exhausted",
  unavailableMessage: "Runner updates unavailable",
  unavailableLog: "Runner limit write budget unavailable",
});

async function withRunnerLimits<T>(
  context: Context & { session: NonNullable<Context["session"]> },
  run: (session: { userId: string; sessionId: string }) => Promise<T>,
): Promise<T> {
  if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
  try {
    return await run({ userId: context.session.user.id, sessionId: context.session.session.id });
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof RunnerLimitsError) throw new ORPCError(error.code);
    if (error instanceof RunnerMachineSessionRevokedError) throw new ORPCError("UNAUTHORIZED");
    if (error instanceof RunnerMachineForbiddenError) throw new ORPCError("FORBIDDEN");
    // Neither submitted credentials nor storage parameter values enter an error cause.
    throw new ORPCError("SERVICE_UNAVAILABLE");
  }
}

export const cliAccessRouter = {
  runners: {
    getLimits: protectedProcedure
      .input(z.strictObject({ id: entityId }))
      .handler(({ input, context }) =>
        withRunnerLimits(context, (session) => runnerLimitsService.get(session, input.id)),
      ),
    proveLimits: protectedProcedure
      .input(runnerLimitsProofRequestSchema)
      .handler(({ input, context }) =>
        withRunnerLimits(context, async (session) => {
          await limitProofBudget(session.userId);
          const proof = await runnerLimitsService.prove(session, input);
          if (!proof) throw new ORPCError("FORBIDDEN");
          return proof;
        }),
      ),
    setLimits: protectedProcedure
      .input(runnerLimitsSetRequestSchema)
      .handler(({ input, context }) =>
        withRunnerLimits(context, async (session) => {
          await limitWriteBudget(session.userId);
          return runnerLimitsService.set(session, input);
        }),
      ),
    claim: protectedProcedure
      .input(z.strictObject({ token: runnerClaimTokenSchema }))
      .handler(async ({ input, context }) => {
        if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
        try {
          return await runnerClaimService.claim(
            { userId: context.session.user.id, sessionId: context.session.session.id },
            input.token,
          );
        } catch (error) {
          if (error instanceof RunnerClaimNotFoundError) throw new ORPCError("NOT_FOUND");
          if (error instanceof RunnerMachineSessionRevokedError)
            throw new ORPCError("UNAUTHORIZED");
          if (error instanceof RunnerMachineForbiddenError) throw new ORPCError("FORBIDDEN");
          if (error instanceof RunnerMachineLimitError) throw new ORPCError("TOO_MANY_REQUESTS");
          if (error instanceof RunnerMachineInputError) throw new ORPCError("BAD_REQUEST");
          // Storage errors may carry token-bearing SQL parameters. Never forward
          // their cause to the shared oRPC error logger.
          throw new ORPCError("SERVICE_UNAVAILABLE");
        }
      }),
    list: protectedProcedure.input(cursorPageInput).handler(({ input, context }) =>
      withRunnerBrowserSession(context, async (tx, userId) => {
        const rows = await tx.runnerMachine.findMany({
          where: withCursor({ userId }, "createdAt", input.cursor, "desc"),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageTake(input.limit),
          select: runnerSelect,
        });
        const now = new Date();
        const page = cursorPage(rows, input.limit, "createdAt");
        return {
          ...page,
          items: page.items.map((machine) => ({
            ...machine,
            status: machine.revokedAt
              ? ("revoked" as const)
              : machine.expiresAt <= now
                ? ("expired" as const)
                : ("active" as const),
          })),
        };
      }),
    ),
    revoke: protectedProcedure.input(z.object({ id: entityId })).handler(({ input, context }) =>
      withRunnerBrowserSession(context, async (tx, userId) => {
        const own = await tx.runnerMachine.findFirst({
          where: { id: input.id, userId },
          select: { id: true },
        });
        if (!own) throw new ORPCError("NOT_FOUND", { message: "Runner not found" });
        await revokeRunnerMachinesInTransaction(tx, userId, own.id);
        return { success: true };
      }),
    ),
  },
  /**
   * A fresh copy-paste install command. Minted on every call (the page
   * refetches on mount) so the embedded token is always newly issued and
   * expires 15 minutes later.
   */
  installCommand: protectedProcedure.handler(async ({ context }) => {
    if (!isCliReleaseConfigured()) {
      return { available: false as const };
    }
    if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
    let capability: ReturnType<typeof createCliInstallToken>;
    try {
      capability = await mintCliCredentialForSession(
        { userId: context.session.user.id, sessionId: context.session.session.id },
        {
          mint: async () => createCliInstallToken(context.session.user.id),
          // A stateless capability is never returned if the locked post-check
          // fails. Its redemption independently checks durable owner state.
          discard: async () => {},
        },
      );
    } catch (error) {
      if (error instanceof CliCredentialSessionRevokedError) throw new ORPCError("UNAUTHORIZED");
      throw error;
    }
    const { token, expiresAt } = capability;
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
        // Under the user's CLI-credential lock, after re-checking that the
        // session that asked still exists: the request was authorized
        // earlier (possibly from the 60 s cookie cache), and a password reset
        // that finished since must not leave a key behind
        // (packages/auth/src/device-redemption-lock.ts).
        try {
          return await mintCliCredentialForSession(
            { userId, sessionId: context.session.session.id },
            {
              mint: () => mintApiKey(userId, input),
              discard: (created) =>
                prisma.apiKey.deleteMany({ where: { id: created.id, referenceId: userId } }),
            },
          );
        } catch (error) {
          if (error instanceof CliCredentialSessionRevokedError)
            throw new ORPCError("UNAUTHORIZED");
          throw error;
        }
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

/**
 * Insert one API key for `userId`, enforcing {@link MAX_API_KEYS_PER_USER}.
 * Only `apiKeys.create` calls it, inside the CLI-credential lock.
 */
async function mintApiKey(
  userId: string,
  input: { name: string; expiresInDays: (typeof API_KEY_EXPIRY_DAYS)[number] },
) {
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
}
