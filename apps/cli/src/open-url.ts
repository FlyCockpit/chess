import { spawn } from "node:child_process";

import { isWsl } from "./platform";

/**
 * Best-effort: open `url` in the user's browser. Never throws — the URL is
 * always printed too, for SSH sessions and headless machines. Windows (and
 * WSL, through interop) uses rundll32's URL handler, which avoids cmd.exe's
 * quoting rules for `&` in query strings.
 */
export function openUrl(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : isWsl()
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}
