/** A portable backup envelope binds the erasure checkpoint to the dump bytes. */
import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAccountDeletionRegisterHead,
  readAccountDeletionRegister,
} from "./account-deletion-suppression.mjs";

const MAGIC = "COCKPIT-CHESS-BACKUP-v1\n";
const HEADER_BYTES = 512;

/**
 * Capture AFTER pg_dump completes: every deletion preceding its DB snapshot
 * is covered; deletions racing the dump may conservatively be included too.
 * Verify ancestry of the pre-dump checkpoint so a mount rollback fails closed.
 * @param {string} path @param {string | undefined} directory @param {string} before
 */
export async function sealBackupArchive(path, directory, before) {
  const snapshot = await readAccountDeletionRegister(directory);
  assertAccountDeletionRegisterHead(snapshot, before);
  const source = await open(path, "r");
  const staged = `${path}.sealed`;
  let output;
  let created = false;
  try {
    output = await open(staged, "wx", 0o600);
    created = true;
    await output.writeFile(Buffer.alloc(HEADER_BYTES, " "));
    const digest = createHash("sha256");
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      await output.writeFile(chunk);
    }
    const metadata = JSON.stringify({
      version: 1,
      registerHead: snapshot.head,
      archiveSha256: digest.digest("hex"),
    });
    const header = Buffer.from(`${MAGIC}${metadata}`.padEnd(HEADER_BYTES, " "));
    if (header.length !== HEADER_BYTES)
      throw new Error("Backup checkpoint exceeds header capacity");
    await output.write(header, 0, header.length, 0);
    await output.sync();
    await output.close();
    output = undefined;
    await rename(staged, path);
    return snapshot.head;
  } finally {
    await source.close();
    await output?.close();
    if (created)
      await unlink(staged).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

/**
 * Copy and hash from one open descriptor into private restore scratch. Neither
 * a sidecar nor the DB being restored can supply/replace this checkpoint.
 * @param {string} path @param {string} destination
 */
export async function unsealBackupArchive(path, destination) {
  const source = await open(path, "r");
  let output;
  let completed = false;
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await source.read(header, 0, header.length, 0);
    if (bytesRead !== HEADER_BYTES || !header.toString("utf8").startsWith(MAGIC))
      throw new Error(
        "Backup has no verifiable deletion-register checkpoint. Use a backup created by the guarded image backup command; keep writers stopped. See docs/backup-restore.md.",
      );
    const metadata = JSON.parse(header.toString("utf8").slice(MAGIC.length).trimEnd());
    if (
      !metadata ||
      Object.keys(metadata).sort().join(",") !== "archiveSha256,registerHead,version" ||
      metadata.version !== 1 ||
      typeof metadata.registerHead !== "string" ||
      !/^(0|[1-9][0-9]{0,5}):[a-f0-9]{64}$/.test(metadata.registerHead) ||
      typeof metadata.archiveSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.archiveSha256)
    )
      throw new Error("Invalid backup deletion-register checkpoint");
    output = await open(destination, "wx", 0o600);
    const digest = createHash("sha256");
    for await (const chunk of source.createReadStream({ start: HEADER_BYTES, autoClose: false })) {
      digest.update(chunk);
      await output.writeFile(chunk);
    }
    if (digest.digest("hex") !== metadata.archiveSha256)
      throw new Error("Backup bytes do not match their deletion-register checkpoint checksum");
    completed = true;
    return metadata.registerHead;
  } finally {
    await source.close();
    await output?.close();
    if (!completed && output) await unlink(destination);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, path, before] = process.argv.slice(2);
    if (command !== "seal" || !path || !before || process.argv.length !== 5)
      throw new Error("Usage: register-backup.mjs seal <archive> <pre-dump-register-head>");
    console.log(await sealBackupArchive(path, process.env.ACCOUNT_DELETION_REGISTER_DIR, before));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
