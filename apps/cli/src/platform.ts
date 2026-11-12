import { readFileSync } from "node:fs";
import { CLI_PLATFORMS, type CliPlatform } from "@cockpit-chess/config/cli";

/** The release asset key for this machine, or null when no build exists for it. */
export function currentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CliPlatform | null {
  const os = platform === "win32" ? "windows" : platform;
  // Windows on ARM runs the x64 build under emulation; there is no native one.
  const cpu = os === "windows" ? "x64" : arch;
  const key = `${os}-${cpu}`;
  return key in CLI_PLATFORMS ? (key as CliPlatform) : null;
}

/** WSL reports itself as Linux; its kernel string names Microsoft. */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}
