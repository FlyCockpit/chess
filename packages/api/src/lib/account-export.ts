import { isAccountDeletionPending } from "@cockpit-chess/auth/account-state";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import {
  lockCliCredentials,
  withCliCredentialLockSlot,
} from "@cockpit-chess/auth/device-redemption-lock";
import { runnerLimitStateSchema } from "@cockpit-chess/auth/runner-limits";
import {
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
} from "@cockpit-chess/auth/two-factor-policy";
import { MAX_ARCHIVE_BYTES, pendingHumanMoveSchema } from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";
import { exportPgn, pgnTagValue } from "@cockpit-chess/chess/pgn";
import { spectatorEvaluationsSchema } from "@cockpit-chess/chess/spectator";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { readStoredArchive } from "./chess-archive";

const PAGE_SIZE = 50;
const MATCH_PAGE_SIZE = 5;
const REAUTH_MS = 5 * 60_000;
const MAX_DURATION_MS = 4 * 60_000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export type AccountExportIdentity = { userId: string; sessionId: string };
type Options = { signal?: AbortSignal };
export class AccountExportError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "REAUTH_REQUIRED" | "FORBIDDEN" | "ABORTED" | "LIMIT_EXCEEDED",
  ) {
    super(code);
    this.name = "AccountExportError";
  }
}

/** Every user-connected model must have a deliberate disclosure decision. */
export const accountExportModelPolicy: Readonly<
  Record<string, { disposition: "exported" | "excluded"; reason: string }>
> = {
  User: {
    disposition: "exported",
    reason: "Own account metadata, excluding internal cleanup progress.",
  },
  Session: { disposition: "exported", reason: "Own session metadata, never bearer tokens." },
  Account: {
    disposition: "exported",
    reason: "Linked identity metadata, never password hashes or OAuth tokens.",
  },
  TwoFactor: {
    disposition: "exported",
    reason: "Enrollment and lockout metadata, never TOTP secrets or backup codes.",
  },
  ChessMatch: {
    disposition: "exported",
    reason: "All own private and published match metadata and supported archives.",
  },
  ChessReplayReport: {
    disposition: "exported",
    reason:
      "Only reports filed by the requesting account; no reporter joins, IP deduplication digests or other users' reports.",
  },
  ChessModerationAction: {
    disposition: "exported",
    reason:
      "Statements of reasons about the requesting uploader's own replays only; other-account privileged audit and administrator identities are excluded.",
  },
  OpenRouterConnection: {
    disposition: "exported",
    reason: "Connection metadata, never key ciphertext, nonce or encryption secret identifier.",
  },
  DeviceCode: {
    disposition: "exported",
    reason: "Approval metadata, never device or user authentication codes.",
  },
  ApiKey: {
    disposition: "exported",
    reason: "Named credential metadata, never key hashes or unrestricted metadata payloads.",
  },
  RunnerMachine: {
    disposition: "exported",
    reason: "Machine inventory metadata, never credential digests.",
  },
  RunnerClaim: {
    disposition: "exported",
    reason: "Pairing timestamps and linked machine metadata, never claim or CLI proof digests.",
  },
  RunnerCommand: {
    disposition: "excluded",
    reason:
      "Internal delivery envelopes duplicate authoritative owned match configuration; match content and machine inventory are exported from their own records.",
  },
  RunnerEvent: {
    disposition: "excluded",
    reason:
      "Internal idempotency digests and delivery receipts contain no independent profile or transcript; authoritative owned games are exported separately.",
  },
  ChessCreation: {
    disposition: "excluded",
    reason: "Purpose-bound idempotency digests; contains no account profile or transcript.",
  },
  ChessOfficialEntry: {
    disposition: "excluded",
    reason:
      "Permanent public model/results ledger independent of account identity; match metadata identifies official participation.",
  },
  Verification: {
    disposition: "exported",
    reason:
      "Only current own-machine runner-limits:v1 state is exported; reset, verification, SSO, TOTP, step-up proof and replay-fence namespaces are excluded authentication credentials.",
  },
};

const userSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  role: true,
  locale: true,
  banned: true,
  banReason: true,
  banExpires: true,
  twoFactorEnabled: true,
  operationalAlerts: true,
  deletionRequestedAt: true,
} satisfies Prisma.UserSelect;
const accountSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  accountId: true,
  providerId: true,
  issuer: true,
  scope: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
} satisfies Prisma.AccountSelect;
const sessionSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  authenticatedAt: true,
  expiresAt: true,
  ipAddress: true,
  userAgent: true,
  origin: true,
} satisfies Prisma.SessionSelect;
const factorSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  verified: true,
  failedVerificationCount: true,
  lockedUntil: true,
} satisfies Prisma.TwoFactorSelect;
const deviceSelect = {
  id: true,
  expiresAt: true,
  status: true,
  lastPolledAt: true,
  pollingInterval: true,
  clientId: true,
  scope: true,
} satisfies Prisma.DeviceCodeSelect;
const apiKeySelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  start: true,
  prefix: true,
  enabled: true,
  expiresAt: true,
  lastRequest: true,
  requestCount: true,
} satisfies Prisma.ApiKeySelect;
const runnerSelect = {
  id: true,
  displayName: true,
  credentialPrefix: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastSeenAt: true,
  connectionGeneration: true,
} satisfies Prisma.RunnerMachineSelect;
const claimSelect = {
  id: true,
  createdAt: true,
  expiresAt: true,
  claimedAt: true,
  machineId: true,
} satisfies Prisma.RunnerClaimSelect;
const connectionSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  keyHash: true,
  keyHint: true,
  label: true,
  limitMicros: true,
  expiresAt: true,
  status: true,
  lastCheckedAt: true,
} satisfies Prisma.OpenRouterConnectionSelect;
const reportSelect = {
  id: true,
  createdAt: true,
  matchId: true,
  reason: true,
  note: true,
  reviewedAt: true,
} satisfies Prisma.ChessReplayReportSelect;
const moderationActionSelect = {
  id: true,
  createdAt: true,
  matchId: true,
  hidden: true,
  reason: true,
  note: true,
} satisfies Prisma.ChessModerationActionSelect;
const matchSelect = {
  id: true,
  publicId: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
  title: true,
  whiteName: true,
  blackName: true,
  status: true,
  published: true,
  hiddenAt: true,
  moderationReason: true,
  moderationNote: true,
  moderationVersion: true,
  source: true,
  rulesKey: true,
  rulesVersion: true,
  promptVersion: true,
  promptHash: true,
  contextMode: true,
  identityMode: true,
  archive: true,
  result: true,
  whiteModel: true,
  whiteProtocol: true,
  blackModel: true,
  blackProtocol: true,
  whiteIllegal: true,
  blackIllegal: true,
  whiteTruncated: true,
  blackTruncated: true,
  whiteCostMicros: true,
  blackCostMicros: true,
  moveFormat: true,
  terminalCause: true,
  credentialSource: true,
  ending: true,
  spectatorEvaluations: true,
  pendingMove: true,
  OfficialEntry: { select: { id: true } },
} satisfies Prisma.ChessMatchSelect;

/** A second allow-list at serialization keeps mock/adapter extras out too. */
function project<T extends object>(
  row: T,
  select: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(select).map((key) => [key, Reflect.get(row, key)]));
}
function stringify(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
function assertRunning(options: Options, startedAt: number) {
  if (options.signal?.aborted) throw new AccountExportError("ABORTED");
  if (Date.now() - startedAt > MAX_DURATION_MS) throw new AccountExportError("LIMIT_EXCEEDED");
}

async function authority(tx: Prisma.TransactionClient, identity: AccountExportIdentity) {
  const now = new Date();
  const live = await tx.session.findFirst({
    where: {
      id: identity.sessionId,
      userId: identity.userId,
      origin: "sign-in",
      impersonatedBy: null,
      expiresAt: { gt: now },
    },
    select: { authenticatedAt: true, user: { select: userSelect } },
  });
  if (!live) throw new AccountExportError("UNAUTHORIZED");
  if (isAccountDeletionPending(live.user) || isUserBanned(live.user))
    throw new AccountExportError("FORBIDDEN");
  const authenticatedAt = live.authenticatedAt?.getTime();
  if (
    authenticatedAt === undefined ||
    authenticatedAt > now.getTime() ||
    now.getTime() - authenticatedAt > REAUTH_MS
  )
    throw new AccountExportError("REAUTH_REQUIRED");
  const key = forcedTwoFactorSettingKeyForRole(live.user.role);
  const setting = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (
    !isTwoFactorRequirementSatisfied(
      live.user,
      isForcedTwoFactorEnabled(key, setting?.value),
      now.getTime(),
    )
  )
    throw new AccountExportError("FORBIDDEN");
  return live.user;
}

async function guardedRead<T>(
  identity: AccountExportIdentity,
  options: Options,
  startedAt: number,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertRunning(options, startedAt);
  return withCliCredentialLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', '15000ms', true)`;
        await lockCliCredentials(identity.userId, tx);
        await authority(tx, identity);
        const result = await read(tx);
        await authority(tx, identity);
        assertRunning(options, startedAt);
        return result;
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    ),
  );
}

export async function assertAccountExportAuthority(
  identity: AccountExportIdentity,
  options: Options = {},
): Promise<void> {
  await guardedRead(identity, options, Date.now(), async () => undefined);
}

async function* pages<T extends { id: string }>(
  identity: AccountExportIdentity,
  options: Options,
  startedAt: number,
  take: number,
  read: (tx: Prisma.TransactionClient, afterId: string | undefined) => Promise<T[]>,
): AsyncGenerator<T[]> {
  let afterId: string | undefined;
  for (let page = 0; page < 100_000; page++) {
    const rows = await guardedRead(identity, options, startedAt, (tx) => read(tx, afterId));
    if (rows.length === 0) return;
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last || (afterId !== undefined && first.id <= afterId))
      throw new AccountExportError("LIMIT_EXCEEDED");
    yield rows;
    if (rows.length < take) return;
    afterId = last.id;
  }
  throw new AccountExportError("LIMIT_EXCEEDED");
}

function archiveForExport(input: unknown, status?: string, ending?: unknown) {
  try {
    if (Buffer.byteLength(stringify(input), "utf8") > MAX_ARCHIVE_BYTES)
      throw new Error("Archive size");
    return { archive: readStoredArchive(input, status, ending), archiveError: null };
  } catch {
    return { archive: null, archiveError: "unsupported_ruleset_archive" };
  }
}

/** Pull-based, bounded per-table reads; no export artifact or email link is stored. */
export async function* streamAccountExport(
  identity: AccountExportIdentity,
  format: "json" | "pgn",
  options: Options = {},
): AsyncGenerator<string> {
  const startedAt = Date.now();
  const upperCreatedAt = new Date(startedAt);
  let totalBytes = 0;
  const emit = (chunk: string) => {
    assertRunning(options, startedAt);
    totalBytes += Buffer.byteLength(chunk, "utf8");
    if (totalBytes > MAX_DOWNLOAD_BYTES) throw new AccountExportError("LIMIT_EXCEEDED");
    return chunk;
  };
  const keyset = (afterId: string | undefined) => (afterId ? { id: { gt: afterId } } : {});
  const user = await guardedRead(identity, options, startedAt, (tx) => authority(tx, identity));
  if (format === "json") {
    yield emit(
      `{"format":"cockpit-chess-account/v1","exportedAt":${stringify(upperCreatedAt)},"account":${stringify(project(user, userSelect))}`,
    );
    const sections = [
      [
        "linkedAccounts",
        accountSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.account.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: accountSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "sessions",
        sessionSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.session.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: sessionSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "twoFactors",
        factorSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.twoFactor.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: factorSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "deviceApprovals",
        deviceSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.deviceCode.findMany({
            where: { userId: identity.userId, ...keyset(afterId) },
            select: deviceSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "apiKeys",
        apiKeySelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.apiKey.findMany({
            where: {
              referenceId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: apiKeySelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "runnerMachines",
        runnerSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.runnerMachine.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: runnerSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "runnerClaims",
        claimSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.runnerClaim.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: claimSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
      [
        "openRouterConnections",
        connectionSelect,
        (tx: Prisma.TransactionClient, afterId: string | undefined) =>
          tx.openRouterConnection.findMany({
            where: {
              userId: identity.userId,
              createdAt: { lte: upperCreatedAt },
              ...keyset(afterId),
            },
            select: connectionSelect,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          }),
      ],
    ] as const;
    for (const [name, select, read] of sections) {
      yield emit(`,${stringify(name)}:[`);
      let comma = "";
      for await (const rows of pages<{ id: string }>(
        identity,
        options,
        startedAt,
        PAGE_SIZE,
        read,
      )) {
        for (const row of rows) {
          yield emit(comma + stringify(project(row, select)));
          comma = ",";
        }
      }
      yield emit("]");
    }
    yield emit(',"runnerLimitStates":[');
    let stateComma = "";
    for await (const machines of pages(
      identity,
      options,
      startedAt,
      PAGE_SIZE,
      async (tx, afterId) => {
        const owned = await tx.runnerMachine.findMany({
          where: {
            userId: identity.userId,
            createdAt: { lte: upperCreatedAt },
            ...keyset(afterId),
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
        });
        const ids = owned.map((machine) => `runner-limits:v1:${machine.id}`);
        const states =
          ids.length === 0
            ? []
            : await tx.verification.findMany({
                where: { id: { in: ids } },
                select: { id: true, identifier: true, value: true, expiresAt: true },
                take: PAGE_SIZE,
              });
        const byId = new Map(states.map((state) => [state.id, state]));
        return owned.map((machine) => {
          const id = `runner-limits:v1:${machine.id}`;
          const row = byId.get(id);
          if (!row || row.expiresAt <= new Date()) return { id: machine.id, state: null };
          const unsupported = { machineId: machine.id, stateError: "unsupported_runner_state" };
          if (row.identifier !== id || Buffer.byteLength(row.value, "utf8") > 8192)
            return { id: machine.id, state: unsupported };
          try {
            const parsed = runnerLimitStateSchema.safeParse(JSON.parse(row.value));
            if (
              !parsed.success ||
              parsed.data.userId !== identity.userId ||
              parsed.data.machineId !== machine.id
            )
              return { id: machine.id, state: unsupported };
            const state = parsed.data;
            if (
              state.operatingLimits.matchMicros > state.hardLimits.matchMicros ||
              state.operatingLimits.dayMicros > state.hardLimits.dayMicros ||
              state.operatingLimits.concurrency > state.hardLimits.concurrency
            )
              return { id: machine.id, state: unsupported };
            return {
              id: machine.id,
              state: {
                machineId: machine.id,
                generation: state.generation,
                expiresAt: row.expiresAt,
                operatingLimits: state.operatingLimits,
                hardLimits: state.hardLimits,
                pending: state.pending,
                lastResult: state.lastResult,
              },
            };
          } catch {
            return { id: machine.id, state: unsupported };
          }
        });
      },
    )) {
      for (const machine of machines) {
        if (machine.state === null) continue;
        yield emit(stateComma + stringify(machine.state));
        stateComma = ",";
      }
    }
    yield emit("]");
    yield emit(',"matches":[');
  }
  let comma = "";
  for await (const rows of pages(identity, options, startedAt, MATCH_PAGE_SIZE, (tx, afterId) =>
    tx.chessMatch.findMany({
      where: { ownerId: identity.userId, createdAt: { lte: upperCreatedAt }, ...keyset(afterId) },
      select: matchSelect,
      orderBy: { id: "asc" },
      take: MATCH_PAGE_SIZE,
    }),
  )) {
    for (const row of rows) {
      const parsed = archiveForExport(row.archive, row.status, row.ending);
      if (format === "pgn") {
        if (parsed.archive) yield emit(`${exportPgn(parsed.archive)}\n`);
        else
          yield emit(
            `[Event "Unsupported ruleset/archive"]\n[Site "?"]\n[Result "*"]\n[CockpitMatchId "${pgnTagValue(row.id, "CockpitMatchId")}"]\n\n*\n\n`,
          );
      } else {
        const ending = endingSummarySchema.safeParse(row.ending);
        const evaluations = spectatorEvaluationsSchema.safeParse(row.spectatorEvaluations);
        const pendingMove = pendingHumanMoveSchema.safeParse(row.pendingMove);
        yield emit(
          comma +
            stringify({
              ...project(row, matchSelect),
              ...parsed,
              OfficialEntry: row.OfficialEntry ? { id: row.OfficialEntry.id } : null,
              ending: ending.success ? ending.data : null,
              spectatorEvaluations: evaluations.success ? evaluations.data : null,
              pendingMove: pendingMove.success ? pendingMove.data : null,
            }),
        );
        comma = ",";
      }
    }
  }
  if (format === "json") {
    await guardedRead(identity, options, startedAt, async () => undefined);
    yield emit('],"reports":[');
    let reportComma = "";
    for await (const rows of pages(identity, options, startedAt, PAGE_SIZE, (tx, afterId) =>
      tx.chessReplayReport.findMany({
        where: {
          reporterId: identity.userId,
          createdAt: { lte: upperCreatedAt },
          ...keyset(afterId),
        },
        select: reportSelect,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      }),
    )) {
      for (const row of rows) {
        yield emit(reportComma + stringify(project(row, reportSelect)));
        reportComma = ",";
      }
    }
    await guardedRead(identity, options, startedAt, async () => undefined);
    yield emit('],"moderationActions":[');
    let actionComma = "";
    for await (const rows of pages(identity, options, startedAt, PAGE_SIZE, (tx, afterId) =>
      tx.chessModerationAction.findMany({
        where: {
          Match: { is: { ownerId: identity.userId } },
          createdAt: { lte: upperCreatedAt },
          ...keyset(afterId),
        },
        select: moderationActionSelect,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      }),
    )) {
      for (const row of rows) {
        yield emit(actionComma + stringify(project(row, moderationActionSelect)));
        actionComma = ",";
      }
    }
  }
  await guardedRead(identity, options, startedAt, async () => undefined);
  if (format === "json") yield emit("]}");
}
