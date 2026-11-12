import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CLI_CHECKSUMS_ASSET, CLI_PLATFORMS } from "@cockpit-chess/config/cli";
import type { Command } from "commander";

import { createApiClient, toCliError } from "../api";
import type { StoredCredential } from "../config";
import { loadConfig, resolveCredential, resolveServer } from "../config";
import { CliError, ExitCode } from "../exit";
import { info } from "../output";
import { currentPlatform } from "../platform";
import { compareVersions, parseChecksums, sha256Hex } from "../release";
import { VERSION } from "../version";

// `cockpit-chess update` — the in-binary twin of re-running the install command. It
// asks the app which release it serves, downloads that build through the
// app's /api/cli/download endpoint (authorized by the stored credential),
// verifies it against SHA256SUMS, and swaps the running binary.

/**
 * Download one release asset. The app answers with a redirect to a short-lived
 * GitHub URL; follow it manually so the credential is sent ONLY to the app,
 * never to the redirect target.
 */
async function download(
  server: string,
  credential: StoredCredential,
  asset: string,
): Promise<Uint8Array> {
  const first = await fetch(`${server}/api/cli/download/${asset}`, {
    headers: { authorization: `Bearer ${credential.value}` },
    redirect: "manual",
  });
  const location = first.headers.get("location");
  if (first.status === 401) {
    throw new CliError(
      "Not signed in, or your session expired. Run `cockpit-chess login`.",
      ExitCode.Unauthenticated,
    );
  }
  if (first.status < 300 || first.status >= 400 || !location) {
    throw new CliError(`Download of ${asset} failed (HTTP ${first.status}).`);
  }
  const response = await fetch(location);
  if (!response.ok) throw new CliError(`Download of ${asset} failed (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The installed binary, or null when running from source (`pnpm dev`, tsx, node). */
function installedBinaryPath(): string | null {
  const name = basename(process.execPath).toLowerCase();
  return name === "cockpit-chess" || name === "cockpit-chess.exe" ? process.execPath : null;
}

/** Replace `target` with `bytes`. A running binary can be renamed but, on Windows, not overwritten. */
async function replaceBinary(target: string, bytes: Uint8Array): Promise<void> {
  const next = join(dirname(target), `.${basename(target)}.new`);
  await writeFile(next, bytes, { mode: 0o755 });
  if (process.platform === "win32") {
    const old = `${target}.old`;
    await rm(old, { force: true });
    await rename(target, old);
    await rename(next, target);
    return;
  }
  await chmod(next, 0o755);
  await rename(next, target);
}

/** Leftover from a previous Windows update; harmless if it is still locked. */
export async function cleanUpPreviousUpdate(): Promise<void> {
  const target = installedBinaryPath();
  if (process.platform === "win32" && target)
    await rm(`${target}.old`, { force: true }).catch(() => {});
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Update cockpit-chess to the release this server offers")
    .option("--check", "only report whether an update is available")
    .action(async (options: { check?: boolean }) => {
      const config = await loadConfig();
      const server = resolveServer(config, program.opts<{ server?: string }>().server);
      const credential = resolveCredential(config, server);
      if (!credential)
        throw new CliError("Not signed in. Run `cockpit-chess login`.", ExitCode.Unauthenticated);

      const release = await createApiClient(server, credential)
        .latestRelease()
        .catch((error: unknown) => {
          throw toCliError(error, server);
        });
      if (!release.available) throw new CliError("This server does not offer CLI downloads.");
      if (compareVersions(release.version, VERSION) <= 0) {
        info(`cockpit-chess ${VERSION} is up to date.`);
        return;
      }
      if (options.check) {
        info(`Update available: ${VERSION} → ${release.version}. Run \`cockpit-chess update\`.`);
        return;
      }

      const target = installedBinaryPath();
      if (!target) {
        throw new CliError(
          "`cockpit-chess update` only works on an installed binary. From source, pull and rebuild instead.",
        );
      }
      const platform = currentPlatform();
      if (!platform)
        throw new CliError(
          `No cockpit-chess build exists for ${process.platform}-${process.arch}.`,
        );
      const asset = CLI_PLATFORMS[platform];

      info(`Downloading cockpit-chess ${release.version} (${asset})...`);
      const [binary, sums] = await Promise.all([
        download(server, credential, asset),
        download(server, credential, CLI_CHECKSUMS_ASSET),
      ]);
      const expected = parseChecksums(new TextDecoder().decode(sums)).get(asset);
      if (!expected) throw new CliError(`No checksum published for ${asset}; refusing to update.`);
      if (sha256Hex(binary) !== expected)
        throw new CliError(`Checksum mismatch for ${asset}; refusing to update.`);

      await replaceBinary(target, binary);
      info(`Updated cockpit-chess ${VERSION} → ${release.version}.`);
    });
}
