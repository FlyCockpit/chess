import type { Command } from "commander";
import { t } from "../chess-i18n";
import { CliError } from "../exit";
import { printResult } from "../output";
import { localRunnerAuthority, readLocalRunnerOptions } from "../runner-policy";
import { recoverRunner } from "../runner-recovery";
import { localRunnerOverrides, type RunnerStartupFlags, terminalClaimant } from "../runner-start";

export function registerRunnerRecover(program: Command): void {
  program
    .command("runner-recover")
    .description(
      t("cli:runnerRecoveryHelp", {
        defaultValue: "Inspect uncertain local runner work; no network requests",
      }),
    )
    .option("--provider-url <url>", t("cli:runner.providerHelp"))
    .option(
      "--resolve-as-spent",
      t("cli:runnerRecoveryConfirm", {
        defaultValue: "Count full uncertain reservations as spent and abandon affected games",
      }),
    )
    .option("--json", t("cli:runnerRecoveryJson", { defaultValue: "Print JSON" }))
    .action(async (flags: RunnerStartupFlags & { resolveAsSpent?: boolean; json?: boolean }) => {
      try {
        // Explicit subcommand flags override explicit root flags, which override file values.
        const local = await readLocalRunnerOptions(
          localRunnerOverrides({ ...program.opts<RunnerStartupFlags>(), ...flags }),
        );
        const result = await recoverRunner({
          authorityId: localRunnerAuthority(local),
          resolve: Boolean(flags.resolveAsSpent),
        });
        printResult(result, Boolean(flags.json ?? program.opts<{ json?: boolean }>().json), () =>
          [
            t("cli:runnerRecoverySummary", {
              defaultValue:
                "Unsettled requests: {{requests}}; uncertain games: {{games}}; settlement blocked: {{blocked}}; resolved: {{resolved}}",
              requests: result.requests.length,
              games: result.games.length,
              blocked: t(result.blocked ? "cli:runnerRecoveryYes" : "cli:runnerRecoveryNo"),
              resolved: t(result.resolved ? "cli:runnerRecoveryYes" : "cli:runnerRecoveryNo"),
            }),
            ...result.requests.map((request) =>
              t("cli:runnerRecoveryRequest", {
                requestId: terminalClaimant(request.requestId),
                matchId: terminalClaimant(request.matchId),
                reserved: request.reservedMicros,
                micros: request.micros,
                atMs: request.atMs,
              }),
            ),
            ...result.games.map((game) =>
              t("cli:runnerRecoveryGame", {
                matchId: terminalClaimant(game.matchId),
                phase: t(`cli:runnerRecoveryPhase.${game.phase}`),
              }),
            ),
          ].join("\n"),
        );
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(t("cli:runnerRecoveryFailed"));
      }
    });
}
