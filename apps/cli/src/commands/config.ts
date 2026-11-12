import type { Command } from "commander";

import { isSettableKey, loadConfig, SETTABLE_KEYS, saveConfig } from "../config";
import { DEFAULT_SERVER } from "../default-server";
import { CliError, ExitCode } from "../exit";
import { printResult } from "../output";
import { configFile } from "../paths";

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Read and write CLI settings");

  config
    .command("path")
    .description("Print the config file location")
    .action(() => {
      process.stdout.write(`${configFile()}\n`);
    });

  config
    .command("show")
    .description("Print the settings (credentials are never printed)")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const { credentials, ...settings } = await loadConfig();
      const shown = {
        ...settings,
        defaultServer: DEFAULT_SERVER ?? "",
        // Which servers have a stored login, and what kind — never the value.
        signedIn: Object.entries(credentials ?? {})
          .map(([server, credential]) => `${server} (${credential.kind})`)
          .join(", "),
      };
      printResult(shown, Boolean(options.json), () =>
        Object.entries(shown)
          .map(([key, value]) => `${key} = ${String(value)}`)
          .join("\n"),
      );
    });

  config
    .command("get")
    .description(`Print one setting (${SETTABLE_KEYS.join(", ")})`)
    .argument("<key>")
    .action(async (key: string) => {
      if (!isSettableKey(key)) throw new CliError(`Unknown setting "${key}".`, ExitCode.Usage);
      const value = (await loadConfig())[key];
      if (value === undefined) throw new CliError(`"${key}" is not set.`, ExitCode.NotFound);
      process.stdout.write(`${value}\n`);
    });

  config
    .command("set")
    .description(`Change one setting (${SETTABLE_KEYS.join(", ")})`)
    .argument("<key>")
    .argument("<value>")
    .action(async (key: string, value: string) => {
      if (!isSettableKey(key)) throw new CliError(`Unknown setting "${key}".`, ExitCode.Usage);
      const current = await loadConfig();
      await saveConfig({ ...current, [key]: value });
    });
}
