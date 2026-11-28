import { Command } from "commander";

import { t } from "./chess-i18n";
import { registerAuth } from "./commands/auth";
import { registerChess } from "./commands/chess";
import { registerConfig } from "./commands/config";
import { registerRunner } from "./commands/runner";
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
    .showHelpAfterError()
    .exitOverride();
  registerChess(program);
  registerConfig(program);
  registerAuth(program);
  registerUpdate(program);
  registerRunner(program);
  return program;
}
