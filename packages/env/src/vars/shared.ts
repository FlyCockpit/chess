import { z } from "zod";
import { httpUrl, originUrl } from "../url.js";

// ---------------------------------------------------------------------------
// Worker-safe variable DECLARATIONS.
//
// Split out of ../shared.ts so that tooling can read the key set without
// importing that module — which runs validation that throws when the variables
// are unset (exactly the situation in CI). Nothing in this directory may have
// import side effects. Dotenv loading lives in ../load-dotenv.ts / ../root-env.ts
// and is imported only from process entrypoints.
//
// `pnpm env:check` (scripts/lib/env-schema.ts) enumerates every module in this
// directory and takes `Object.keys()` of each exported declaration object, so a
// new variable is visible to the manifest check the moment it is added here.
// Declaring one inline in ../shared.ts instead would hide it — the check fails
// on that too.
// ---------------------------------------------------------------------------

export const strictBooleanFlag = (defaultValue: boolean = false) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

export const sharedVars = {
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Max connections in this process's Postgres pool (node-postgres `max`).
  // Default 10 matches the driver default — raise it only against the
  // database's connection budget, since every server/worker replica holds its
  // own pool. See docs/deployment.md
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Fresh UUID set by the image entrypoint for each server/worker host.
  // Admission and the serving-process heartbeat must share this identity.
  COCKPIT_CHESS_INSTANCE_ID: z.uuid().optional(),
  // BACKUP_ENABLED controls freshness monitoring only (including setup-missing).
  // Writing uses the canonical backup commands and opt-in BACKUP_SCHEDULE.
  // Writer/restore credentials and ListBucket-only monitor credentials stay separate.
  BACKUP_ENABLED: strictBooleanFlag(true),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  // The worker only lists objects for freshness; it never reads or writes a
  // dump. Keep that ListBucket-only identity separate from the dump key.
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_ENDPOINT: httpUrl("BACKUP_S3_ENDPOINT").optional(),
  BACKUP_S3_PREFIX: z.string().default("database"),
  BACKUP_S3_FORCE_PATH_STYLE: strictBooleanFlag(),
  // Newest dump older than this = stale. 36h tolerates one missed nightly
  // run plus clock skew without paging anyone; two misses always alert.
  BACKUP_MAX_AGE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(36),
  // ---- Translation provider (optional). Used by `pnpm i18n:translate` to
  // fill non-default locale bundles. The validator keeps both API keys optional so the rest of the
  // app boots without them; the provider factory throws at first use if the
  // key for the chosen provider is missing.
  //
  // Default provider is `openrouter` because it's the cheapest path to
  // claude-haiku-4-5 + gives a single account multi-model access for A/B
  // experiments. Set TRANSLATION_PROVIDER=anthropic to call the Anthropic
  // API directly with ANTHROPIC_API_KEY.
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TRANSLATION_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
  // Optional public origin metadata for translation providers such as
  // OpenRouter. This is not used for auth and is safe for worker-only env.
  PUBLIC_APP_URL: originUrl("PUBLIC_APP_URL").optional(),
  // ---- Email transport (optional). Shared because both the server and the
  // worker use @cockpit-chess/mailer. Keeping SMTP here lets worker-only deploys
  // opt into failure-alert emails without setting Better-Auth server vars.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Admin-only hosted inference is opt-in; local chess needs no provider key.
  CHESS_HOSTED_ENABLED: strictBooleanFlag(false),
  // Per-call model override. Falls through to the provider's default
  // (`anthropic/claude-haiku-4-5` for OpenRouter, `claude-haiku-4-5` for
  // direct Anthropic) when unset.
  TRANSLATION_MODEL: z.string().min(1).optional(),
};
