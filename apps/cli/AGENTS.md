# CLI agent & contributor guide

This file covers the companion CLI under `apps/cli` (`@cockpit-chess/cli`, binary
`cockpit-chess`). The repo-root `AGENTS.md` still applies — its rules override this
file. Read the authentication and release code before changing either contract.

## What this is

A TypeScript CLI built on `commander`, talking to the app through a typed oRPC
client (`cliRouter`), and compiled in CI into standalone binaries with
`bun build --compile`. It is an ordinary pnpm workspace member: the root
`pnpm lint`, `check-types`, `test`, and `verify:fast` cover it.

## Orientation

| Path | What's there |
|------|--------------|
| `src/main.ts` | Entry point: run the program, map errors to exit codes. Keep it thin. |
| `src/program.ts` | The command tree. Register new commands here. |
| `src/commands/` | One file per command, each exporting `register<Name>(program)`. |
| `src/api.ts` | The typed oRPC client and error → `CliError` mapping. |
| `src/device-flow.ts` | `cockpit-chess login` (RFC 8628 against Better-Auth). |
| `src/config.ts`, `src/paths.ts` | JSON config (server, per-server credentials, settings) in the per-user config dir, 0600. A credential is only sent to the origin it is stored under. |
| `src/default-server.ts` | The built-in default server (build-time `COCKPIT_CHESS_DEFAULT_SERVER` or a hardcoded value). |
| `src/exit.ts` | Stable exit codes and `CliError`. |
| `src/output.ts` | stdout for results (`--json`), stderr for everything else. |
| `src/release.ts`, `src/platform.ts` | Checksums, version compare, platform → release asset. |
| `scripts/compile.ts` | `bun build --compile` for every target (CI only); inlines `COCKPIT_CHESS_DEFAULT_SERVER`. |

## Everyday commands

From the repo root:

```sh
pnpm --filter @cockpit-chess/cli dev --help   # run from source (tsx)
pnpm --filter @cockpit-chess/cli test
pnpm --filter @cockpit-chess/cli check-types
pnpm biome check apps/cli
```

Use `COCKPIT_CHESS_CONFIG_DIR=<tmp dir>` so experiments never touch your real config,
and `COCKPIT_CHESS_SERVER=http://localhost:3000` (or `--server`) to point at local dev.

## Rules

1. **Import `@cockpit-chess/api` as types only.** `import type { CliRouterClient }`
   is the whole contract; a value import would bundle server code into the
   binary. `src/api.test.ts` enforces it. Runtime dependencies stay minimal and
   go through the root dependency rules (ask before adding one).
2. **Portable Node APIs only.** The source runs on Node in development and on
   the Bun runtime in the compiled binary. Avoid Node-only internals and
   native addons; `cli-build.yml` smoke-tests Linux x64/arm64, macOS arm64,
   and Windows (the Intel macOS build is compiled and signed, not executed).
3. **stdout is for results.** Every command that prints data supports `--json`.
   Progress, prompts, and notices go to stderr.
4. **Exit codes are a contract** (`src/exit.ts`): 0 ok, 1 error, 2 usage,
   3 not found, 4 not signed in. Throw `CliError` with the right code; add a
   new code only with a README entry.
5. **Never log or print a credential.** `config show` omits it; keep it that way.
6. **New server calls go through `cliRouter`**, never `/rpc` (cookie-only) and
   never a raw `fetch` to an app route. Mount existing procedures there.
7. **CLI contract lifecycle.** 1.0.0 establishes the first CLI contract; until it is published remove unreleased shapes instead of keeping compatibility; after release, add, never break.
8. **Inject IO in pure logic** (`fetch`, clock, sleep), like `device-flow.ts`,
   and unit-test it next to the source. Tests never hit a real server.

## Adding a command

1. Use the `replay` command in `src/commands/chess.ts` as the model for
   `src/commands/<name>.ts`, exporting `register<Name>(program)`.
2. Register it in `src/program.ts`.
3. Put the logic in exported pure functions and test them in
   `src/commands/<name>.test.ts`.
4. If it needs the server: add or mount the procedure in
   `packages/api/src/routers/cli.ts` (with a test), then resolve
   `const server = resolveServer(config, …)` and
   `const credential = resolveCredential(config, server)` (throw
   `CliError(…, ExitCode.Unauthenticated)` when it is undefined) and call
   `createApiClient(server, credential)`, mapping failures with `toCliError`.
   `src/commands/auth.ts` (`whoami`) is the worked example.
5. Run the commands above.

## Releasing

Bump `version` in `package.json`, merge, and run the root **Release** workflow
with the matching `vX.Y.Z` tag.
