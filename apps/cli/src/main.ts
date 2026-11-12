#!/usr/bin/env node
import { CommanderError } from "commander";

import { cleanUpPreviousUpdate } from "./commands/update";
import { CliError, ExitCode } from "./exit";
import { buildProgram } from "./program";

// Entry point: run the command tree and map errors to stable exit codes
// (src/exit.ts). Keep it thin.

async function main(): Promise<number> {
  await cleanUpPreviousUpdate();
  try {
    await buildProgram().parseAsync(process.argv);
    return ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit 0; argument errors were already printed.
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.Usage;
    }
    if (error instanceof CliError) {
      process.stderr.write(`cockpit-chess: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(
      `cockpit-chess: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (process.env.COCKPIT_CHESS_DEBUG && error instanceof Error)
      process.stderr.write(`${error.stack}\n`);
    return ExitCode.Failure;
  }
}

process.exitCode = await main();
