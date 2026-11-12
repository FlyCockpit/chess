import type { Command } from "commander";

import { createApiClient, toCliError } from "../api";
import {
  loadConfig,
  resolveCredential,
  resolveServer,
  type StoredCredential,
  saveConfig,
  withCredential,
} from "../config";
import { pollForToken, requestDeviceCode } from "../device-flow";
import { CliError, ExitCode } from "../exit";
import { openUrl } from "../open-url";
import { info, printResult } from "../output";
import { compareVersions } from "../release";
import { VERSION } from "../version";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function registerAuth(program: Command): void {
  program
    .command("login")
    .description("Sign in: approve this terminal in your browser, or store an API key")
    .option("--with-api-key", "read an API key from stdin instead (for CI and scripts)")
    .option("--no-browser", "print the approval URL without opening a browser")
    .action(async (options: { withApiKey?: boolean; browser: boolean }) => {
      const config = await loadConfig();
      const server = resolveServer(config, program.opts<{ server?: string }>().server);

      let credential: StoredCredential;
      if (options.withApiKey) {
        if (process.stdin.isTTY) {
          throw new CliError(
            "Pipe the key on stdin so it stays out of shell history, e.g. `cockpit-chess login --with-api-key < key.txt`.",
            ExitCode.Usage,
          );
        }
        const key = await readStdin();
        if (!key) throw new CliError("No API key on stdin.", ExitCode.Usage);
        credential = { kind: "api-key", value: key };
      } else {
        const code = await requestDeviceCode(server);
        info(
          `To sign in, open:\n\n  ${code.verificationUriComplete}\n\nand confirm the code ${code.userCode}`,
        );
        if (options.browser) openUrl(code.verificationUriComplete);
        info("\nWaiting for approval...");
        credential = { kind: "session", value: await pollForToken(server, code) };
      }

      // Verify before saving, so a typo'd key never replaces a working login.
      const me = await createApiClient(server, credential)
        .whoami()
        .catch((error: unknown) => {
          throw toCliError(error, server);
        });
      // Stored under this origin only; other servers' logins are untouched.
      await saveConfig(withCredential(config, server, credential));
      info(`Signed in to ${server} as ${me.email}.`);
    });

  program
    .command("logout")
    .description("Sign out of the server and forget its stored credential")
    .action(async () => {
      const config = await loadConfig();
      const server = resolveServer(config, program.opts<{ server?: string }>().server);
      const credential = config.credentials?.[server];
      if (!credential) {
        info(`Not signed in to ${server}.`);
        return;
      }
      try {
        if (credential.kind === "session") {
          // Best effort: the transport bounds revoke to ten seconds.
          await createApiClient(server, credential, 10_000)
            .logout()
            .catch(() => undefined);
        }
      } finally {
        await saveConfig(withCredential(config, server, undefined));
      }
      info(
        credential.kind === "api-key"
          ? `Forgot the API key for ${server}. Revoke it in the app's settings if it is no longer needed.`
          : `Signed out of ${server}.`,
      );
    });

  program
    .command("whoami")
    .description("Show who you are signed in as")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      const server = resolveServer(config, program.opts<{ server?: string }>().server);
      const credential = resolveCredential(config, server);
      if (!credential)
        throw new CliError(
          `Not signed in to ${server}. Run \`cockpit-chess login\`.`,
          ExitCode.Unauthenticated,
        );
      const client = createApiClient(server, credential);
      const [me, release] = await Promise.all([
        client.whoami(),
        client.latestRelease().catch(() => ({ available: false as const })),
      ]).catch((error: unknown) => {
        throw toCliError(error, server);
      });
      printResult(
        { ...me, server },
        Boolean(options.json),
        () => `${me.name} <${me.email}> on ${server}`,
      );
      if (release.available && compareVersions(release.version, VERSION) > 0) {
        info(
          `A newer cockpit-chess is available (${VERSION} → ${release.version}). Run \`cockpit-chess update\`.`,
        );
      }
    });
}
