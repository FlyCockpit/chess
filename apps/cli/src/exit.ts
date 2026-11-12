// Process exit codes. A CLI's exit code is part of its contract with scripts
// and agents — keep these stable and document any you add in README.md.
//
//   0  success
//   1  generic runtime error
//   2  usage error (commander emits this for bad arguments)
//   3  the requested resource was not found
//   4  not signed in, or the stored credential was rejected
export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
  NotFound: 3,
  Unauthenticated: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An error the CLI reports as one line on stderr, with a specific exit code. */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = ExitCode.Failure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
