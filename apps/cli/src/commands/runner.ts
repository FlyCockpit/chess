import type { Command } from "commander";
import { t } from "../chess-i18n";
import { type RunnerStartupFlags, runRunnerStartup } from "../runner-start";

/** The root action applies only when no explicit companion subcommand was selected. */
export function registerRunner(program: Command): void {
  program
    .option(
      "--resume <machineId>",
      t("cli:runner.resumeHelp", {
        defaultValue: "Resume an existing runner at this server without creating a claim",
      }),
    )
    .option(
      "--max-match-usd <usd>",
      t("cli:runner.matchHelp", { defaultValue: "Local hard USD ceiling per match" }),
    )
    .option(
      "--max-day-usd <usd>",
      t("cli:runner.dayHelp", { defaultValue: "Local hard USD ceiling per day" }),
    )
    .option(
      "--max-concurrency <count>",
      t("cli:runner.concurrencyHelp", { defaultValue: "Local hard concurrency ceiling" }),
    )
    .option(
      "--provider-url <url>",
      t("cli:runner.providerHelp", {
        defaultValue: "Local inference endpoint (never sent to the server)",
      }),
    )
    .option(
      "--allow-model <ids...>",
      t("cli:runner.modelsHelp", {
        defaultValue: "Local model allowlist (narrows the locally fetched catalog)",
      }),
    )
    .action(async () => {
      await runRunnerStartup(program.opts<RunnerStartupFlags>());
    });
}
