import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  serializeArchive,
  validateArchive,
} from "@cockpit-chess/chess";
import { t } from "./chess-i18n";

const writers = new Map<string, Promise<void>>();
export async function readGame(file: string) {
  if ((await stat(file)).size > MAX_ARCHIVE_BYTES) throw new Error(t("cli.message33"));
  const raw = await readFile(file, "utf8");
  if (Buffer.byteLength(raw) > MAX_ARCHIVE_BYTES) throw new Error(t("cli.message33"));
  return validateArchive(JSON.parse(raw));
}
async function writeAtomically(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function writeGame(file: string, match: MatchArchive) {
  const target = path.resolve(file);
  const content = serializeArchive(match);
  const previous = writers.get(target) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => writeAtomically(target, content));
  writers.set(target, write);
  try {
    await write;
  } finally {
    if (writers.get(target) === write) writers.delete(target);
  }
}
