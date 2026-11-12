import type { MatchArchive, MatchConfig } from "@cockpit-chess/chess";
import type { ProviderCredentials } from "@cockpit-chess/chess/runner";
import { z } from "zod";
import { t } from "./chess-i18n";

export interface LocalProviderOptions {
  baseUrl?: string;
  inputPrice?: string;
  outputPrice?: string;
}

/** A provider configuration problem whose (translated, key-free) message is safe to show. */
export class ProviderConfigError extends Error {
  override name = "ProviderConfigError";
}

type Protocol = MatchConfig["white"]["protocol"];
type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Parse and validate an inference endpoint; throws ProviderConfigError for unsafe URLs. */
function providerEndpoint(baseUrl: string = DEFAULT_BASE_URL) {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new ProviderConfigError(t("cli.secureEndpoint"));
  }
  const local = LOOPBACK_HOSTS.includes(endpoint.hostname);
  if (
    (!local && endpoint.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(endpoint.protocol)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new ProviderConfigError(t("cli.secureEndpoint"));
  return { endpoint, local };
}

/**
 * The one place that decides which local environment key may be sent where.
 * Each vendor key only goes to that vendor's host; loopback endpoints get no
 * key unless COCKPIT_CHESS_PROVIDER_KEY is set; any other host needs
 * COCKPIT_CHESS_PROVIDER_KEY. Returns undefined when no key applies.
 */
export function resolveApiKey(
  endpoint: URL,
  protocol: Protocol,
  env: Env = process.env,
): string | undefined {
  if (protocol === "random" || protocol === "human") return undefined;
  const pick = (value: string | undefined) => (value ? value : undefined);
  switch (endpoint.hostname) {
    case "openrouter.ai":
      return pick(env.OPENROUTER_API_KEY);
    case "api.openai.com":
      return pick(env.OPENAI_API_KEY);
    case "api.anthropic.com":
      return pick(env.ANTHROPIC_API_KEY);
    default:
      return pick(env.COCKPIT_CHESS_PROVIDER_KEY);
  }
}

/** Whether a model game could start against this endpoint with the current environment. */
export function providerReady(baseUrl?: string, env: Env = process.env) {
  try {
    const { endpoint, local } = providerEndpoint(baseUrl);
    return local || resolveApiKey(endpoint, "openai-chat", env) !== undefined;
  } catch {
    return false;
  }
}

/**
 * True inside a `bun build --compile` binary: Bun serves bundled modules from a
 * virtual filesystem (`/$bunfs/root/…` on POSIX, `B:/~BUN/root/…` on Windows).
 */
export function isCompiledBinary(
  moduleUrl: string = import.meta.url,
  hasBun: boolean = "Bun" in globalThis,
) {
  let decoded = moduleUrl;
  try {
    decoded = decodeURIComponent(moduleUrl);
  } catch {}
  return hasBun && /[/\\]\$bunfs[/\\]|~BUN[/\\]/.test(decoded);
}

/**
 * The Stockfish engine runs as a child process from a file on disk, which a
 * compiled binary neither contains nor can spawn, so refuse engine rules there
 * before a match starts instead of failing mid-game.
 */
export function assertEngineSupported(
  config: Pick<MatchConfig, "rules">,
  compiled: boolean = isCompiledBinary(),
) {
  if (compiled && config.rules.engineEvaluation !== "off")
    throw new ProviderConfigError(t("cli.engineUnavailable"));
}

const catalogSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        pricing: z
          .object({ prompt: z.string().optional(), completion: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});
type Catalog = z.infer<typeof catalogSchema>;

const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogCache: { url: string; expires: number; promise: Promise<Catalog> } | undefined;

/** Clears the per-process model catalog memo (tests). */
export function resetCatalogCache() {
  catalogCache = undefined;
}

function modelCatalog(baseUrl: string, signal?: AbortSignal): Promise<Catalog> {
  const url = `${baseUrl}/models`;
  const now = Date.now();
  if (catalogCache && catalogCache.url === url && catalogCache.expires > now)
    return catalogCache.promise;
  const timeout = AbortSignal.timeout(15000);
  const promise = (async () => {
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new ProviderConfigError(t("cli.message30"));
    return catalogSchema.parse(await response.json());
  })();
  const entry = { url, expires: now + CATALOG_TTL_MS, promise };
  catalogCache = entry;
  promise.catch(() => {
    if (catalogCache === entry) catalogCache = undefined;
  });
  return promise;
}

export async function localCredentials(
  match: MatchArchive,
  options: LocalProviderOptions = {},
  signal?: AbortSignal,
): Promise<Partial<Record<"w" | "b", ProviderCredentials>>> {
  const output: Partial<Record<"w" | "b", ProviderCredentials>> = {};
  if (
    [match.config.white, match.config.black].every((player) =>
      ["random", "human"].includes(player.protocol),
    )
  )
    return output;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const { endpoint, local } = providerEndpoint(baseUrl);
  const isOpenRouter = endpoint.hostname === "openrouter.ai";
  for (const side of ["w", "b"] as const) {
    const player = side === "w" ? match.config.white : match.config.black;
    if (player.protocol === "random" || player.protocol === "human") continue;
    if (!local && !resolveApiKey(endpoint, player.protocol))
      throw new ProviderConfigError(t("cli.message31"));
  }
  let catalog: Catalog | undefined;
  if (isOpenRouter) {
    try {
      catalog = await modelCatalog(baseUrl, signal);
    } catch (error) {
      if (error instanceof ProviderConfigError) throw error;
      if (signal?.aborted) throw error;
      throw new ProviderConfigError(t("cli.message30"));
    }
  }
  for (const side of ["w", "b"] as const) {
    const player = side === "w" ? match.config.white : match.config.black;
    if (player.protocol === "random" || player.protocol === "human") continue;
    const apiKey = resolveApiKey(endpoint, player.protocol);
    const pricing = catalog?.data?.find((entry) => entry.id === player.model)?.pricing;
    const inputPrice = isOpenRouter
      ? Number(pricing?.prompt) * 1e12
      : Number(options.inputPrice) * 1e6;
    const outputPrice = isOpenRouter
      ? Number(pricing?.completion) * 1e12
      : Number(options.outputPrice) * 1e6;
    // Negative prices (a bad flag, or OpenRouter's "-1" for variable pricing) are not quotes.
    if (
      !local &&
      (!Number.isFinite(inputPrice) ||
        !Number.isFinite(outputPrice) ||
        inputPrice < 0 ||
        outputPrice < 0)
    )
      throw new ProviderConfigError(t("cli.message32"));
    output[side] = {
      apiKey: apiKey ?? "local-inference",
      baseUrl,
      anthropicAuth: isOpenRouter ? "bearer" : "api-key",
      inputMicrosPerMillion: local ? 0 : Math.ceil(inputPrice),
      outputMicrosPerMillion: local ? 0 : Math.ceil(outputPrice),
    };
  }
  return output;
}
