import { Command } from "commander";

import { t } from "./chess-i18n";
import { registerAuth } from "./commands/auth";
import { registerChess } from "./commands/chess";
import { registerConfig } from "./commands/config";
import { registerRunner } from "./commands/runner";
import { registerRunnerRecover } from "./commands/runner-recover";
import { registerUpdate } from "./commands/update";
import { VERSION } from "./version";

// The command tree. Each command lives in src/commands/<name>.ts and exposes a
// `register<Name>(program)`; add yours here. See apps/cli/AGENTS.md.
export function buildProgram(): Command {
  const program = new Command()
    .name("cockpit-chess")
    .description(
      t("cli.runner.description", {
        defaultValue: "Cockpit Chess: connect a runner, or use companion commands",
      }),
    )
    .version(VERSION, "-V, --version")
    .option("--server <url>", "app server to talk to (overrides config and COCKPIT_CHESS_SERVER)")
    .option(
      "--json",
      t("cli:runnerRecoveryRootJson", { defaultValue: "Print JSON for commands that support it" }),
    )
    .showHelpAfterError()
    .exitOverride();
  registerChess(program);
  registerConfig(program);
  registerAuth(program);
  registerUpdate(program);
  registerRunner(program);
  registerRunnerRecover(program);
  // Commander may consume a root option after the subcommand too. Forward it
  // to existing JSON-capable commands so their established output stays JSON.
  program.hook("preAction", (_root, command) => {
    if (
      program.opts<{ json?: boolean }>().json &&
      command.options.some((option) => option.long === "--json") &&
      command.getOptionValueSource("json") !== "cli"
    )
      command.setOptionValueWithSource("json", true, "cli");
  });
  return program;
}
