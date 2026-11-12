import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_SERVER } from "./default-server";
import { CliError } from "./exit";
import { configFile } from "./paths";

// The CLI's config file: JSON, one per user (see paths.ts). It holds
// credentials, so it is written with mode 0600 on POSIX; on Windows it lives
// under the user's %APPDATA%, which only that user can read. Not the OS
// keychain on purpose: WSL and headless Linux usually have no Secret Service,
// and a native keychain module would complicate the single-binary build.

export type StoredCredential = {
  /** "session" from `cockpit-chess login`, "api-key" from `cockpit-chess login --with-api-key`. */
  kind: "session" | "api-key";
  value: string;
};

export type Config = {
  /**
   * The app's API origin, e.g. https://app.example.com. Set by the installer;
   * when absent, the build's DEFAULT_SERVER applies.
   */
  server?: string;
  /**
   * Logins keyed by server origin. A credential is only ever sent to the
   * origin it was issued by, so pointing `--server` at staging can never hand
   * staging a production token.
   */
  credentials?: Record<string, StoredCredential>;
};

/** Keys `cockpit-chess config get/set` may touch. Credentials are managed by login/logout. */
export const SETTABLE_KEYS = ["server"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

export function isSettableKey(key: string): key is SettableKey {
  return (SETTABLE_KEYS as readonly string[]).includes(key);
}

export async function loadConfig(path = configFile()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Config;
  } catch {
    throw new CliError(`Config file ${path} is not valid JSON. Fix or delete it.`);
  }
}

/** Atomic write: a crash mid-save never leaves a truncated config behind. */
export async function saveConfig(config: Config, path = configFile()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

/**
 * Resolve the server origin: --server flag, then COCKPIT_CHESS_SERVER, then the config
 * file, then the build's default (normally production).
 */
export function resolveServer(
  config: Config,
  flag?: string,
  defaultServer: string | undefined = DEFAULT_SERVER,
): string {
  const server = flag ?? process.env.COCKPIT_CHESS_SERVER ?? config.server ?? defaultServer;
  if (!server) {
    throw new CliError(
      "No server configured. Run the install command from the app's settings, or `cockpit-chess config set server https://your-app.example.com`.",
    );
  }
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new CliError(`Server "${server}" is not a valid URL.`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new CliError(
      `Server "${server}" must use https:// (http:// is allowed only for localhost).`,
    );
  }
  return url.origin;
}

/**
 * The credential to send to `server` (an origin from resolveServer):
 * COCKPIT_CHESS_API_KEY (CI and scripts) wins, so a pipeline never depends on a
 * developer's local login; otherwise the login stored for that exact origin.
 * COCKPIT_CHESS_API_KEY is sent to whichever server the invocation resolves, so CI
 * sets COCKPIT_CHESS_SERVER next to it.
 */
export function resolveCredential(config: Config, server: string): StoredCredential | undefined {
  const fromEnv = process.env.COCKPIT_CHESS_API_KEY;
  if (fromEnv) return { kind: "api-key", value: fromEnv };
  return config.credentials?.[server];
}

/** `config` with the login for `server` replaced (or removed when undefined). */
export function withCredential(
  config: Config,
  server: string,
  credential: StoredCredential | undefined,
): Config {
  const { [server]: _previous, ...others } = config.credentials ?? {};
  const credentials = credential ? { ...others, [server]: credential } : others;
  const { credentials: _all, ...rest } = config;
  return Object.keys(credentials).length > 0 ? { ...rest, credentials } : rest;
}
