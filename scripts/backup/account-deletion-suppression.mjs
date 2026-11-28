/**
 * Restricted, write-ahead erasure register. This directory is an operator-owned
 * persistent volume, never a file in a database dump. Expiry is a review date:
 * records are not automatically pruned while any older backup can be restored.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, opendir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const PURPOSE = "cockpit-chess:account-deletion:v1:";
const RETENTION_MS = 31 * 24 * 60 * 60_000;
const MAX_RECORDS = 100_000;
const MAX_RECORD_BYTES = 512;
const HASH = /^[a-f0-9]{64}$/;

/** @param {string} userId */
export function accountDeletionSubjectHash(userId) {
  if (typeof userId !== "string" || !userId || userId.length > 200)
    throw new Error("Invalid account deletion subject");
  return createHash("sha256").update(PURPOSE).update(userId).digest("hex");
}

/** @param {unknown} value */
function validateRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid deletion suppression record");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "expiresAt,requestedAt,subjectHash,version")
    throw new Error("Unsupported deletion suppression record");
  const record = /** @type {Record<string, unknown>} */ (value);
  const date = (input) =>
    typeof input === "string" &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input;
  if (
    record.version !== 1 ||
    typeof record.subjectHash !== "string" ||
    !HASH.test(record.subjectHash) ||
    !date(record.requestedAt) ||
    !date(record.expiresAt) ||
    Date.parse(/** @type {string} */ (record.expiresAt)) -
      Date.parse(/** @type {string} */ (record.requestedAt)) <
      RETENTION_MS
  )
    throw new Error("Invalid deletion suppression record");
  return /** @type {{version: 1, subjectHash: string, requestedAt: string, expiresAt: string}} */ (
    value
  );
}

/** @param {string | undefined} directory */
async function openDirectory(directory) {
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error(
      "Configure an absolute ACCOUNT_DELETION_REGISTER_DIR on restricted persistent storage",
    );
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "Deletion suppression directory must be owned by this process user with mode 0700",
    );
  return open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

/** Check deployment readiness before accepting a new destructive request. */
export async function assertAccountDeletionRegisterAvailable(directory) {
  const parent = await openDirectory(directory);
  try {
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  } finally {
    await parent.close();
  }
}

/** @param {string} path @param {string} expectedHash */
async function readRecord(path, expectedHash) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > MAX_RECORD_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Deletion suppression record is not a restricted regular file");
    const record = validateRecord(JSON.parse(await file.readFile("utf8")));
    if (record.subjectHash !== expectedHash)
      throw new Error("Deletion suppression filename does not match its subject");
    return record;
  } finally {
    await file.close();
  }
}

/**
 * Fsync the record and directory before physical cleanup can proceed. Atomic
 * linking makes retries and concurrent workers idempotent; a crash cannot leave
 * a partially written visible record. A failed append always leaves deletion pending.
 * @param {{directory: string | undefined, userId: string, requestedAt: Date, now?: Date}} input
 */
export async function appendAccountDeletionSuppression({
  directory,
  userId,
  requestedAt,
  now = new Date(),
}) {
  const parent = await openDirectory(directory);
  const subjectHash = accountDeletionSubjectHash(userId);
  const destination = join(/** @type {string} */ (directory), `${subjectHash}.json`);
  const pending = join(
    /** @type {string} */ (directory),
    `.pending-${subjectHash}-${randomUUID()}`,
  );
  let created = false;
  try {
    const record = validateRecord({
      version: 1,
      subjectHash,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(
        Math.max(now.getTime(), requestedAt.getTime()) + RETENTION_MS,
      ).toISOString(),
    });
    const file = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(pending, destination);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      await readRecord(destination, subjectHash);
    }
    await parent.sync();
  } finally {
    try {
      if (created) await unlink(pending);
    } finally {
      await parent.close();
    }
  }
}

/**
 * Missing, unreadable, malformed or over-capacity registers refuse a restore.
 * No record is skipped because its advisory expiry passed.
 * @param {string | undefined} directory
 */
export async function readAccountDeletionSuppressions(directory) {
  const parent = await openDirectory(directory);
  const records = [];
  try {
    for await (const entry of await opendir(/** @type {string} */ (directory))) {
      // An unlinked staging file cannot authorize account removal and is not a
      // committed suppression; a future append safely retries it.
      if (/^\.pending-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const hash = /^([a-f0-9]{64})\.json$/.exec(entry.name)?.[1];
      if (!hash) throw new Error("Unknown file in deletion suppression register");
      if (records.length >= MAX_RECORDS)
        throw new Error("Deletion suppression register exceeds restore capacity");
      records.push(await readRecord(join(/** @type {string} */ (directory), entry.name), hash));
    }
    return records;
  } finally {
    await parent.close();
  }
}

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;

/**
 * Reapply the external register in the SAME restore transaction, before COMMIT.
 * Restored accounts are fenced pending, never declared physically erased. Existing
 * public readers hide pending-owner replays; the deletion worker resumes the same
 * scrub/private-delete flow. This must precede reopening any server/worker admission.
 * @param {{version: 1, subjectHash: string, requestedAt: string, expiresAt: string}[]} records
 * @param {string} schema
 */
export function accountDeletionSuppressionSql(records, schema = "public") {
  if (!records.length) return "";
  const current = records.map(validateRecord);
  const table = (name) => `${ident(schema)}.${ident(name)}`;
  // Temporary table is session-local; it never adds restoration identifiers to
  // a restorable application table or touches the permanent official ledger.
  return `CREATE TEMP TABLE deletion_suppressed_users (id text PRIMARY KEY, requested_at timestamptz NOT NULL) ON COMMIT DROP;
INSERT INTO deletion_suppressed_users (id, requested_at)
SELECT u.id, r.requested_at::timestamptz FROM ${table("user")} u
JOIN (VALUES ${current.map((r) => `(${literal(r.subjectHash)}, ${literal(r.requestedAt)})`).join(",")}) AS r(subject_hash, requested_at)
ON encode(sha256(convert_to(${literal(PURPOSE)} || u.id, 'UTF8')), 'hex') = r.subject_hash;
UPDATE ${table("user")} u SET "deletionRequestedAt" = COALESCE(u."deletionRequestedAt", d.requested_at), "deletionState" = 'pending', "deletionCursor" = NULL
FROM deletion_suppressed_users d WHERE u.id = d.id;
DELETE FROM ${table("session")} WHERE "userId" IN (SELECT id FROM deletion_suppressed_users) OR "impersonatedBy" IN (SELECT id FROM deletion_suppressed_users);
DELETE FROM ${table("apikey")} WHERE "referenceId" IN (SELECT id FROM deletion_suppressed_users);
DELETE FROM ${table("device_code")} WHERE "userId" IN (SELECT id FROM deletion_suppressed_users);
DELETE FROM ${table("account")} WHERE "userId" IN (SELECT id FROM deletion_suppressed_users);
DELETE FROM ${table("two_factor")} WHERE "userId" IN (SELECT id FROM deletion_suppressed_users);
DELETE FROM ${table("openrouter_connection")} WHERE "userId" IN (SELECT id FROM deletion_suppressed_users);
UPDATE ${table("runner_machine")} SET "revokedAt" = COALESCE("revokedAt", now()), "connectionGeneration" = "connectionGeneration" + 1 WHERE "userId" IN (SELECT id FROM deletion_suppressed_users);
UPDATE ${table("chess_match")} SET status = 'stopped', "runToken" = NULL, "terminalCause" = 'owner-delete', ending = '{"kind":"cancelled"}'::jsonb,
"turnType" = 'idle', "turnId" = NULL, "turnSide" = NULL, "turnExpectedSeq" = NULL, "turnStartedAt" = NULL, "turnDeadline" = NULL, "pendingMove" = NULL,
"runnerState" = CASE WHEN source = 'runner' THEN 'stopped' ELSE "runnerState" END, "runnerGeneration" = NULL, "runnerResumeDeadline" = NULL,
"runnerRevision" = "runnerRevision" + CASE WHEN source = 'runner' THEN 1 ELSE 0 END
WHERE "ownerId" IN (SELECT id FROM deletion_suppressed_users) AND status IN ('queued', 'running');
UPDATE ${table("runner_command")} SET "cancelledAt" = now() WHERE "ackedAt" IS NULL AND "cancelledAt" IS NULL
AND "matchId" IN (SELECT id FROM ${table("chess_match")} WHERE "ownerId" IN (SELECT id FROM deletion_suppressed_users));
`;
}
