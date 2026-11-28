/**
 * Restricted, write-ahead erasure register on an operator-owned persistent
 * volume, never in a database dump. Entries form an append-only digest chain.
 * An independently protected head checkpoint detects rollback to a valid prefix;
 * the chain alone cannot detect removal of its tail. Expiry is a review date:
 * records are not automatically pruned while any older backup can be restored.
 * @typedef {{version: 2, subjectHash: string, requestedAt: string, expiresAt: string,
 * sequence: number, previousDigest: string, digest: string}} AccountDeletionSuppression
 * @typedef {{head: string, records: AccountDeletionSuppression[]}} AccountDeletionRegister
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, opendir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PURPOSE = "cockpit-chess:account-deletion:v1:";
const REGISTER_PURPOSE = "cockpit-chess:account-deletion-register:v2:";
const RETENTION_MS = 31 * 24 * 60 * 60_000;
const MAX_RECORDS = 100_000;
const MAX_RECORD_BYTES = 512;
const HASH = /^[a-f0-9]{64}$/;
const GENESIS_DIGEST = "0".repeat(64);
export const EMPTY_REGISTER_HEAD = `0:${GENESIS_DIGEST}`;

/** @param {string} userId */
export function accountDeletionSubjectHash(userId) {
  if (typeof userId !== "string" || !userId || userId.length > 200)
    throw new Error("Invalid account deletion subject");
  return createHash("sha256").update(PURPOSE).update(userId).digest("hex");
}

/**
 * Canonical UTF-8 JSON with fixed field order and a separate purpose domain.
 * The digest itself is excluded; every other record field is authenticated.
 * @param {Omit<AccountDeletionSuppression, "digest">} record
 */
function recordDigest(record) {
  return createHash("sha256")
    .update(REGISTER_PURPOSE)
    .update(
      JSON.stringify({
        version: record.version,
        sequence: record.sequence,
        previousDigest: record.previousDigest,
        subjectHash: record.subjectHash,
        requestedAt: record.requestedAt,
        expiresAt: record.expiresAt,
      }),
    )
    .digest("hex");
}

/** @param {unknown} value */
function validateRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid deletion suppression record");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "digest,expiresAt,previousDigest,requestedAt,sequence,subjectHash,version")
    throw new Error("Unsupported deletion suppression record");
  const record = /** @type {Record<string, unknown>} */ (value);
  const date = (input) =>
    typeof input === "string" &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input;
  if (
    record.version !== 2 ||
    !Number.isInteger(record.sequence) ||
    /** @type {number} */ (record.sequence) < 1 ||
    /** @type {number} */ (record.sequence) > MAX_RECORDS ||
    typeof record.previousDigest !== "string" ||
    record.previousDigest.length !== 64 ||
    !HASH.test(record.previousDigest) ||
    typeof record.digest !== "string" ||
    record.digest.length !== 64 ||
    !HASH.test(record.digest) ||
    typeof record.subjectHash !== "string" ||
    record.subjectHash.length !== 64 ||
    !HASH.test(record.subjectHash) ||
    !date(record.requestedAt) ||
    !date(record.expiresAt) ||
    Date.parse(/** @type {string} */ (record.expiresAt)) -
      Date.parse(/** @type {string} */ (record.requestedAt)) <
      RETENTION_MS
  )
    throw new Error("Invalid deletion suppression record");
  const valid = /** @type {AccountDeletionSuppression} */ (value);
  if (valid.digest !== recordDigest(valid))
    throw new Error("Deletion suppression record digest mismatch");
  return valid;
}

/** @param {string} head */
function headSequence(head) {
  const match = typeof head === "string" && /^(0|[1-9][0-9]{0,5}):([a-f0-9]{64})$/.exec(head);
  if (
    !match ||
    match[0] !== head ||
    Number(match[1]) > MAX_RECORDS ||
    (match[1] === "0" && head !== EMPTY_REGISTER_HEAD)
  )
    throw new Error("Invalid deletion suppression register head");
  return Number(match[1]);
}

/** @param {AccountDeletionSuppression[]} records */
function validateChain(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS)
    throw new Error("Deletion suppression register exceeds restore capacity");
  let previousDigest = GENESIS_DIGEST;
  const subjects = new Set();
  for (const [index, value] of records.entries()) {
    const record = validateRecord(value);
    if (record.sequence !== index + 1 || record.previousDigest !== previousDigest)
      throw new Error("Deletion suppression register sequence gap or digest chain mismatch");
    if (subjects.has(record.subjectHash))
      throw new Error("Duplicate subject in deletion suppression register");
    subjects.add(record.subjectHash);
    previousDigest = record.digest;
  }
  return `${records.length}:${previousDigest}`;
}

/**
 * Require an independently protected checkpoint, not merely a numeric head at
 * least as recent. Equal or newer snapshots must contain its exact ancestry.
 * @param {AccountDeletionRegister} snapshot
 * @param {string} expectedHead
 */
export function assertAccountDeletionRegisterHead(snapshot, expectedHead) {
  const guidance =
    "A trusted --expected-register-head from an independent protected copy is required";
  let sequence;
  try {
    sequence = headSequence(expectedHead);
  } catch {
    throw new Error(`${guidance}: missing or invalid checkpoint`);
  }
  try {
    if (
      !snapshot ||
      Object.keys(snapshot).sort().join(",") !== "head,records" ||
      validateChain(snapshot.records) !== snapshot.head
    )
      throw new Error("Invalid snapshot");
    headSequence(snapshot.head);
  } catch {
    throw new Error(`${guidance}: invalid register snapshot`);
  }
  if (
    sequence > snapshot.records.length ||
    (sequence > 0 && `${sequence}:${snapshot.records[sequence - 1].digest}` !== expectedHead)
  )
    throw new Error(`${guidance}: register is older than or forked from the trusted checkpoint`);
}

/** @param {string | undefined} directory */
async function openDirectory(directory) {
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error(
      "Configure an absolute ACCOUNT_DELETION_REGISTER_DIR on restricted persistent storage",
    );
  const restricted = (info) =>
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    (!process.getuid || info.uid === process.getuid());
  if (!restricted(await lstat(directory)))
    throw new Error(
      "Deletion suppression directory must be owned by this process user with mode 0700",
    );
  const parent = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!restricted(await parent.stat()))
      throw new Error(
        "Deletion suppression directory must be owned by this process user with mode 0700",
      );
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
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

/** @param {string} path @param {number} sequence @param {boolean} durable */
async function readRecord(path, sequence, durable) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > MAX_RECORD_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Deletion suppression record is not a restricted regular file");
    // Bound the read too, so a growing corrupt file cannot bypass the stat cap.
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_RECORD_BYTES)
      throw new Error("Deletion suppression record exceeds size capacity");
    const record = validateRecord(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    if (record.sequence !== sequence)
      throw new Error("Deletion suppression filename does not match its sequence");
    // Another worker may have linked this file without yet syncing its parent.
    // An idempotent append must establish durability itself before succeeding.
    if (durable) await file.sync();
    return record;
  } finally {
    await file.close();
  }
}

/** @param {string} directory @param {boolean} durable */
async function readRegister(directory, durable) {
  const sequences = [];
  for await (const entry of await opendir(directory)) {
    // Only the random staging names produced below are uncommitted and ignored.
    const staging =
      /^\.pending-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(
        entry.name,
      );
    if (staging?.[0] === entry.name) continue;
    if (entry.name.length !== 17 || !/^[0-9]{12}\.json$/.test(entry.name))
      throw new Error("Unknown file in deletion suppression register");
    const sequence = Number(entry.name.slice(0, 12));
    if (sequence < 1 || sequence > MAX_RECORDS || sequences.length >= MAX_RECORDS)
      throw new Error("Deletion suppression register exceeds restore capacity");
    sequences.push(sequence);
  }
  sequences.sort((a, b) => a - b);
  const records = [];
  for (const [index, sequence] of sequences.entries()) {
    if (sequence !== index + 1) throw new Error("Deletion suppression register sequence gap");
    records.push(
      await readRecord(
        join(directory, `${String(sequence).padStart(12, "0")}.json`),
        sequence,
        durable,
      ),
    );
  }
  return { head: validateChain(records), records };
}

/**
 * CAS by hard-linking the next sequence: distinct concurrent appends serialize
 * without a lock. EEXIST means re-read the winning chain and retry; an existing
 * subject is idempotent. File and directory fsync precede every successful return,
 * including retries that adopt another worker's entry. A failed append leaves
 * deletion pending; no partially written record is ever committed.
 * @param {{directory: string | undefined, userId: string, requestedAt: Date, now?: Date}} input
 */
export async function appendAccountDeletionSuppression({
  directory,
  userId,
  requestedAt,
  now = new Date(),
}) {
  const subjectHash = accountDeletionSubjectHash(userId);
  const dates = {
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(
      Math.max(now.getTime(), requestedAt.getTime()) + RETENTION_MS,
    ).toISOString(),
  };
  const parent = await openDirectory(directory);
  const location = /** @type {string} */ (directory);
  try {
    while (true) {
      const snapshot = await readRegister(location, true);
      if (snapshot.records.some((record) => record.subjectHash === subjectHash)) {
        await parent.sync();
        return;
      }
      if (snapshot.records.length >= MAX_RECORDS)
        throw new Error("Deletion suppression register exceeds restore capacity");
      const payload = {
        version: /** @type {const} */ (2),
        ...dates,
        subjectHash,
        sequence: snapshot.records.length + 1,
        previousDigest: snapshot.head.split(":")[1],
      };
      const record = validateRecord({ ...payload, digest: recordDigest(payload) });
      const destination = join(location, `${String(record.sequence).padStart(12, "0")}.json`);
      const pending = join(location, `.pending-${subjectHash}-${randomUUID()}`);
      let created = false;
      let committed = false;
      try {
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
          committed = true;
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
        }
      } finally {
        if (created) await unlink(pending);
      }
      if (committed) {
        await parent.sync();
        return;
      }
    }
  } finally {
    await parent.close();
  }
}

/**
 * Missing, unreadable, malformed or over-capacity registers refuse a restore.
 * No record is skipped because its advisory expiry passed. The returned chain
 * still needs an independent trusted checkpoint to detect valid-prefix rollback.
 * @param {string | undefined} directory
 */
export async function readAccountDeletionRegister(directory) {
  const parent = await openDirectory(directory);
  try {
    return await readRegister(/** @type {string} */ (directory), false);
  } finally {
    await parent.close();
  }
}

/** @param {string | undefined} directory */
export async function readAccountDeletionSuppressions(directory) {
  return (await readAccountDeletionRegister(directory)).records;
}

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;

/**
 * Reapply the external register in the SAME restore transaction, before COMMIT.
 * Restored accounts are fenced pending, never declared physically erased. Existing
 * public readers hide pending-owner replays; the deletion worker resumes the same
 * scrub/private-delete flow. This must precede reopening any server/worker admission.
 * @param {AccountDeletionSuppression[]} records
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

// Never expose filesystem errors, record contents or configured paths on stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "head") throw new Error("Invalid command");
    const snapshot = await readAccountDeletionRegister(process.env.ACCOUNT_DELETION_REGISTER_DIR);
    console.log(snapshot.head);
  } catch {
    console.error(
      "Unable to read account deletion register head; use: account-deletion-suppression.mjs head with restricted ACCOUNT_DELETION_REGISTER_DIR storage",
    );
    process.exitCode = 1;
  }
}
