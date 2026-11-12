import { homedir } from "node:os";
import { join } from "node:path";

// Per-user config location, matching each platform's convention:
//
//   Linux / WSL  $XDG_CONFIG_HOME/cockpit-chess  (default ~/.config/cockpit-chess)
//   macOS        ~/Library/Application Support/cockpit-chess
//   Windows      %APPDATA%\cockpit-chess
//
// COCKPIT_CHESS_CONFIG_DIR overrides all of them (tests, CI, multiple profiles).

const APP_NAME = "cockpit-chess";

export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.COCKPIT_CHESS_CONFIG_DIR) return env.COCKPIT_CHESS_CONFIG_DIR;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME);
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_NAME);
}

export function configFile(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  return join(configDir(env, platform), "config.json");
}
