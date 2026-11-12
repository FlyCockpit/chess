import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  boardAt,
  createMatch,
  finishMatch,
  type MatchArchive,
  type MatchConfig,
  matchConfigSchema,
  matchStats,
} from "@cockpit-chess/chess";
import { runMatch } from "@cockpit-chess/chess/runner";
import type { Command } from "commander";
import { createApiClient } from "../api";
import { t } from "../chess-i18n";
import {
  assertEngineSupported,
  type LocalProviderOptions,
  localCredentials,
  ProviderConfigError,
} from "../chess-provider";
import { readGame, writeGame } from "../chess-storage";
import { loadConfig, resolveCredential, resolveServer } from "../config";
import { CliError, ExitCode } from "../exit";
import { startLocalChess } from "../local-server";
import { printResult } from "../output";
import { configDir } from "../paths";

export function registerChess(program: Command) {
  program
    .command("serve")
    .description(t("cli.message0"))
    .option("--port <port>", t("cli.message11"), "0")
    .option("--data-dir <path>", t("cli.message12"))
    .option("--assets <path>", t("cli.message13"))
    .option("--base-url <url>", t("cli.message14"))
    .option("--input-price <usd>", t("cli.message15"))
    .option("--output-price <usd>", t("cli.message16"))
    .action(
      async (options: {
        port: string;
        dataDir?: string;
        assets?: string;
        baseUrl?: string;
        inputPrice?: string;
        outputPrice?: string;
      }) => {
        const port = Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new CliError(t("cli.message1"), ExitCode.Usage);
        const local = await startLocalChess({
          ...options,
          port,
          dataDir: options.dataDir ?? path.join(configDir(), "games"),
          assetsDir: options.assets,
          onError: (message) => process.stderr.write(`${message}\n`),
        });
        process.stdout.write(`${local.url}\n`);
        process.stderr.write(`${t("cli.ready")}\n`);
        let closing = false;
        const close = () => {
          if (closing) return;
          closing = true;
          void local
            .close()
            .then(() => {
              process.exitCode = 0;
            })
            .catch(() => {
              process.exitCode = 1;
            });
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
      },
    );
  program
    .command("run")
    .description(t("cli.message2"))
    .requiredOption("--config <file>", t("cli.message17"))
    .option("--out <directory>", t("cli.message18"))
    .option("--games <count>", t("cli.message19"), "1")
    .option("--swap-colors", t("cli.message20"))
    .option("--base-url <url>", t("cli.message21"))
    .option("--input-price <usd>", t("cli.message22"))
    .option("--output-price <usd>", t("cli.message23"))
    .option("--json", t("cli.message24"))
    .action(
      async (options: {
        config: string;
        out?: string;
        games: string;
        swapColors?: boolean;
        json?: boolean;
        baseUrl?: string;
        inputPrice?: string;
        outputPrice?: string;
      }) => {
        const count = Number(options.games);
        if (!Number.isInteger(count) || count < 1 || count > 100)
          throw new CliError(t("cli.message3"), ExitCode.Usage);
        const text = await readFile(options.config, "utf8");
        if (Buffer.byteLength(text) > 64000) throw new CliError(t("cli.message4"), ExitCode.Usage);
        const config = matchConfigSchema.parse(JSON.parse(text));
        if ([config.white, config.black].some((player) => player.protocol === "human"))
          throw new CliError(t("cli.message5"), ExitCode.Usage);
        try {
          assertEngineSupported(config);
        } catch (error) {
          throw new CliError(
            error instanceof Error ? error.message : String(error),
            ExitCode.Usage,
          );
        }
        const out = options.out ?? path.join(configDir(), "games");
        await mkdir(out, { recursive: true, mode: 0o700 });
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        const series = await runSeries({
          config,
          count,
          swapColors: Boolean(options.swapColors),
          out,
          signal: abort.signal,
          provider: options,
        }).finally(() => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        });
        printResult(series.results, Boolean(options.json), () =>
          series.results
            .map((result) => `${result.result} ${result.termination} ${result.file}`)
            .join("\n"),
        );
        if (series.error) throw new CliError(series.error, ExitCode.Failure);
      },
    );
  program
    .command("replay")
    .description(t("cli.message6"))
    .argument("<file>", t("cli.message25"))
    .option("--event <index>", t("cli.message26"))
    .option("--json", t("cli.message27"))
    .action(async (file: string, options: { event?: string; json?: boolean }) => {
      const match = await readGame(file);
      const index = options.event === undefined ? match.events.length - 1 : Number(options.event);
      if (!Number.isInteger(index) || index < -1 || index >= match.events.length)
        throw new CliError(t("cli.message7"), ExitCode.Usage);
      const chess = boardAt(match, index);
      printResult(
        {
          title: match.config.title,
          result: match.result,
          fen: chess.fen(),
          stats: matchStats(match),
          event: match.events[index] ?? null,
        },
        Boolean(options.json),
        () => `${match.config.title}\n${chess.ascii()}\n${match.result} · ${match.termination}`,
      );
    });
  program
    .command("upload")
    .description(t("cli.message8"))
    .argument("<file>", t("cli.message28"))
    .option("--json", t("cli.message29"))
    .action(async (file: string, options: { json?: boolean }, command: Command) => {
      const match = await readGame(file);
      if (match.status === "running") throw new CliError(t("cli.message9"), ExitCode.Usage);
      const config = await loadConfig();
      const server = resolveServer(config, command.optsWithGlobals().server);
      const credential = resolveCredential(config, server);
      if (!credential) throw new CliError(t("cli.message10"), ExitCode.Unauthenticated);
      const result = await createApiClient(server, credential).chess.importGame({
        json: JSON.stringify(match),
      });
      printResult(result, Boolean(options.json), () => t("cli.draft", { slug: result.slug }));
    });
}

export interface SeriesResult {
  id: string;
  file: string;
  result: string;
  termination: string;
  stats: ReturnType<typeof matchStats>;
}
/**
 * Plays the series in order. Credentials are resolved before any archive is
 * written (once per colour layout). The first failure finishes that game as a
 * provider error, persists it, and stops the series; earlier results are kept.
 */
export async function runSeries(input: {
  config: MatchConfig;
  count: number;
  swapColors: boolean;
  out: string;
  signal: AbortSignal;
  provider: LocalProviderOptions;
  run?: typeof runMatch;
  credentials?: typeof localCredentials;
  write?: typeof writeGame;
}): Promise<{ results: SeriesResult[]; error?: string }> {
  const run = input.run ?? runMatch;
  const resolve = input.credentials ?? localCredentials;
  const write = input.write ?? writeGame;
  const results: SeriesResult[] = [];
  const layouts = new Map<boolean, Awaited<ReturnType<typeof localCredentials>>>();
  const record = (match: MatchArchive, file: string) =>
    results.push({
      id: match.id,
      file,
      result: match.result,
      termination: match.termination,
      stats: matchStats(match),
    });
  for (let index = 0; index < input.count && !input.signal.aborted; index += 1) {
    const swapped = input.swapColors && index % 2 === 1;
    const match = createMatch({
      ...input.config,
      white: swapped ? input.config.black : input.config.white,
      black: swapped ? input.config.white : input.config.black,
    });
    const file = path.join(input.out, `${match.id}.json`);
    let credentials = layouts.get(swapped);
    if (!credentials) {
      try {
        credentials = await resolve(match, input.provider, input.signal);
      } catch (error) {
        if (input.signal.aborted) break;
        return { results, error: errorMessage(error) };
      }
      layouts.set(swapped, credentials);
    }
    try {
      await write(file, match);
      await run(match, {
        signal: input.signal,
        credentials,
        onUpdate: (next) => write(file, next),
      });
      if (input.signal.aborted && match.status === "running")
        finishMatch(match, "*", "cancelled", "stopped");
      await write(file, match);
      record(match, file);
    } catch (error) {
      if (match.status === "running") finishMatch(match, "*", "provider-error", "error");
      try {
        await write(file, match);
      } catch {}
      record(match, file);
      return { results, error: errorMessage(error) };
    }
  }
  return { results };
}
const errorMessage = (error: unknown) =>
  error instanceof ProviderConfigError ? error.message : t("cli.runFailed");
