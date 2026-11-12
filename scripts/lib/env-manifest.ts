/**
 * THE canonical description of every environment variable in this repo.
 *
 * Three things read this file:
 *   1. `pnpm generate:secrets`  (scripts/generate-secrets.ts)  — builds a
 *      ready-to-paste production env block, generating what it can and
 *      prompting for what it can't.
 *   2. `pnpm env:sync`          (scripts/sync-env-example.ts)  — regenerates
 *      `.env.example` and `apps/web/.env.example`.
 *      Those files are GENERATED. Do not hand-edit them; edit this
 *      manifest and re-run the script.
 *   3. `pnpm env:check`         (same script, `--check`)       — CI gate. Fails
 *      when a key declared in a `packages/env/src/vars/*.ts` Zod schema is
 *      missing here, or when a generated `.env.example` is stale.
 *
 * ---------------------------------------------------------------------------
 * ADDING A NEW ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 *   1. Declare it in the right `packages/env/src/vars/*.ts` object (shared =
 *      server + worker, server = server-only, web = VITE_*) — never inline in the `createEnv({…})` call one
 *      directory up, which the scan cannot see.
 *   2. Add an entry to `ENV_VARS` below, in an existing group or a new one.
 *   3. Run `pnpm env:sync` and commit the regenerated `.env.example` files.
 *
 * Skipping step 2 fails CI — that is deliberate. A variable that the generator
 * doesn't know about is a variable that silently goes missing from a
 * production deploy and surfaces as a boot crash weeks later.
 *
 * REMOVING A FEATURE MODULE (feature removal): delete that module's
 * group and its vars from this file, then run `pnpm env:sync`.
 */

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

/**
 * Deploy targets the generator knows about. Dokploy on a VPS is the repo's
 * deployment target (`docs/deployment.md`); the cross-platform
 * contract is `docs/deployment.md`.
 */
export const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS / Dokploy",
    doc: "docs/deployment.md",
    injects: [],
    note: "You own the Postgres and Redis instances, so you supply both connection strings.",
  },
  {
    id: "other",
    label: "Other / not sure",
    doc: "docs/deployment.md",
    injects: [],
    note: "Prompting for every non-defaulted variable. Delete anything your platform injects for you.",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which .env file a variable belongs to. */
export type EnvFile = "root" | "web";

interface EnvGroup {
  id: string;
  /** Section heading in the generated .env.example. */
  title: string;
  file?: EnvFile;
  /** Always included; never prompted for. */
  always?: boolean;
  /**
   * Yes/no question gating the whole group in `pnpm generate:secrets`.
   * Omitted for `always` groups and for `tuning` groups.
   */
  prompt?: string;
  /** Default answer to `prompt`. */
  default?: boolean;
  /**
   * Tuning-only group: every var has a schema default, so the generator emits
   * the whole group commented out and never prompts.
   */
  tuning?: boolean;
  /**
   * Force this group on (skipping its yes/no) when an earlier answer makes it
   * mandatory — e.g. SMTP is not optional once SIGNUP_ENABLED is true, because
   * the server hard-throws at boot without it. Without this, the contradiction
   * only surfaces in the final validation pass, after every prompt has been
   * answered, and the whole run has to be redone.
   */
  requiredWhen?: { key: string; equals: string; because: string };
  /**
   * Offer to reuse this group's values from the shell environment the script
   * runs in, when they are already set there. Meant for credentials you hold
   * once and point several prototype apps at (SMTP, object storage, an LLM
   * key) — not for per-app values like BETTER_AUTH_URL or DATABASE_URL, where
   * silently inheriting another app's value is a footgun.
   */
  reuseFromEnv?: boolean;
  /** Comment block emitted above the section. */
  comment?: string[];
}

export interface EnvVar {
  key: string;
  group: string;
  /**
   * - `generate`: the script produces a value with `generator`.
   * - `prompt`:   only you know it — the script asks.
   * - `confirm`:  yes/no question; emits `"true"` only when the answer is yes
   *               (schema default covers the no case).
   * - `enable`:   when this var's group is selected, emit `"true"` automatically
   *               (feature flags that must flip on with their optional block).
   * - `default`:  a documented default value covers it, so the generator never
   *               asks and omits the key (shown commented out under `--all`).
   * - `manual`:   deliberate opt-in with no useful prompt; same emission as
   *               `default`, but documented in `.env.example` (rare — prefer
   *               `prompt`).
   */
  source: "generate" | "prompt" | "confirm" | "enable" | "default" | "manual";
  generator?: "secret32";
  /**
   * The effective default, for documentation only — setting this changes
   * nothing at runtime. Usually mirrors a Zod `.default()`; see `defaultFrom`
   * for the handful that come from application code instead.
   */
  default?: string;
  /**
   * Where `default` actually comes from. `"schema"` (the assumed case) means a
   * Zod `.default()`. `"app"` means the schema field is optional and the
   * fallback lives in application code — say so explicitly, because
   * `pnpm env:check` compares key sets, not defaults, and cannot catch this
   * drifting.
   */
  defaultFrom?: "schema" | "app";
  /**
   * Fixed set of valid values. Rendered as an `Allowed: …` line in
   * `.env.example`, and offered as a pick-list instead of a free-text prompt.
   */
  choices?: Array<{ value: string; label?: string; description?: string }>;
  /**
   * Shape-check applied at the prompt, mirroring the Zod refinement that would
   * otherwise only fire in the final validation pass — so a typo costs one
   * retry instead of the whole run.
   */
  format?: "origin";
  /**
   * Set `false` to keep this var OUT of its group's reuse-from-environment
   * offer, even when the group has `reuseFromEnv`. For values that identify one
   * specific app rather than a shared provider account — inheriting those
   * silently points the new app at the previous one's resources.
   */
  reusable?: boolean;
  /**
   * Let the operator skip this otherwise-required var (empty answer = omit).
   * For values a platform may supply out of band — the generator records the
   * omission in the output header instead of blocking on it.
   */
  omittable?: boolean;
  /** Required once its group is enabled. Prompts are re-asked until answered. */
  required?: boolean;
  /** Question text for `source: "prompt"` / `source: "confirm"`. */
  prompt?: string;
  /** Default answer for `source: "confirm"` (false when omitted). */
  confirmDefault?: boolean;
  /** Extra guidance printed under the prompt. */
  hint?: string;
  /** Placeholder shown in the generated .env.example. */
  example?: string;
  /**
   * Emit this var UNCOMMENTED in the generated .env.example. Reserve it for
   * vars whose `example` is a working local-dev value — a live line with a
   * non-functional placeholder is worse than a commented one, because
   * `emptyStringAsUndefined` won't save you from a wrong value.
   * `source: "generate"` vars are always emitted live but empty.
   */
  exampleSet?: boolean;
  /** True for values that must never be echoed back or logged. */
  secret?: boolean;
  file?: EnvFile;
  /**
   * Set `false` for variables read outside the Zod schemas (e.g. by a shell
   * entrypoint). Excludes the key from the schema-coverage check's expectation
   * that every manifest key is also a schema key.
   */
  inSchema?: boolean;
  /** Comment lines emitted above the var. */
  comment?: string[];
  /**
   * Render into the trailing "Advanced tuning" section of the root
   * `.env.example` instead of the var's own feature section — for one-off
   * knobs a nontechnical operator should never touch (rate-limit budgets,
   * codec settings, cache TTLs). Always commented with the default shown.
   * The manifest and `generate:secrets --all` are unaffected; only the
   * `.env.example` placement moves.
   */
  advanced?: boolean;
  /**
   * Omit from the generated `.env.example` entirely. For deep one-shot knobs
   * (internal script flags, build identity) whose audience
   * reads the env schema and manifest, not the example file — the full catalog stays
   * here and in the Zod schema. Only valid on `source: "default"` /
   * `"manual"` vars (never on anything prompted, generated, or enabling).
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const ENV_GROUPS: EnvGroup[] = [
  {
    id: "core",
    title: "Datastores — [shared] (server + worker)",
    always: true,
  },
  {
    id: "runtime",
    title: "Runtime + migrations — [shared]",
    always: true,
    comment: [
      "The server applies committed migrations on startup by default; workers",
      "wait and register before serving. Set MIGRATE_ON_START=false everywhere",
      "when a separate one-shot migrate job applies them before rollout.",
      "Full contract: docs/schema-migrations.md.",
    ],
  },
  {
    id: "backups",
    title: "Database backups — [shared]",
    prompt: "Configure off-site database backups (S3/R2)?",
    default: true,
    comment: [
      "Verified plain pg_dump snapshots use /backups and an optional private S3 bucket.",
      "Daily writing starts off; enable exactly one BACKUP_SCHEDULE=daily service.",
      "Writer/restore keys need GetObject, GetObjectVersion, PutObject and AbortMultipartUpload;",
      "freshness monitoring uses its own ListBucket-only identity. BACKUP_ENABLED",
      "controls only monitoring, never manual, migration, restore or daily snapshots.",
      "Fresh installs skip snapshots; existing databases without a destination warn;",
      "configured backup failures block migrations. See docs/backup-restore.md.",
    ],
  },
  {
    id: "auth",
    title: "Auth — [server-only]",
    always: true,
  },
  {
    id: "admin",
    title: "Admin + signup — [server-only]",
    always: true,
  },
  {
    id: "smtp",
    reuseFromEnv: true,
    title: "Email (SMTP) — [shared]",
    prompt: "Configure outgoing email (SMTP)?",
    default: true,
    requiredWhen: {
      key: "SIGNUP_ENABLED",
      equals: "true",
      because:
        "public signup is enabled, and Better-Auth enforces email verification — " +
        "the server refuses to boot in production without SMTP",
    },
    comment: [
      "REQUIRED if SIGNUP_ENABLED=true — Better-Auth enforces email verification",
      "on signup, and the server refuses to boot in production without it.",
      "Local dev: `pnpm dev:services` starts a mailpit sink and `pnpm run setup`",
      "  fills these three lines automatically; read captured mail at",
      "  http://localhost:8025",
    ],
  },
  {
    id: "sso",
    title: "SSO / enterprise login — [server-only]",
    prompt: "Configure SSO (OIDC) login?",
    default: false,
    comment: [
      "Optional. FORCE_SSO=true in production requires SSO_ENABLED plus all",
      "three SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_ISSUER values, or the",
      "server throws at boot.",
    ],
  },
  {
    id: "cli",
    title: "Companion CLI downloads — [server-only]",
    prompt: "Serve companion-CLI installs and updates from this app?",
    default: false,
    comment: [
      "Optional. The app's /api/cli/install.sh, install.ps1, and download",
      "endpoints redirect signed-in users to the CLI binaries on this GitHub",
      "repo's Releases. With CLI_RELEASE_REPO unset they return 503. See",
      "packages/api/src/routers/cli.ts",
    ],
  },
  {
    id: "translation",
    reuseFromEnv: true,
    title: "Translation provider — [shared]",
    prompt: "Enable i18n bundle translation?",
    default: false,
    comment: [
      "Used by `pnpm i18n:translate`.",
      "The app boots without these; the worker throws on the first job if the",
      "chosen provider's key is missing. Default provider is `openrouter` with",
      "`anthropic/claude-haiku-4-5` (~$0.05 for a full UI bundle). See apps/web/src/i18n/index.ts.",
    ],
  },
  {
    id: "chess",
    title: "Hosted chess — [shared]",
    tuning: true,
    comment: [
      "Optional hosted inference; local play and public replay need no key.",
      "Hosted matches also need OPENROUTER_API_KEY (declared in the translation group above).",
    ],
  },
  {
    id: "ratelimit",
    title: "Rate limiting — [server-only]",
    tuning: true,
    comment: [
      "Three named budgets (AUTH, RPC, EMAIL), two knobs",
      "each. Each budget describes its family's reference member; every other",
      "limiter in the family scales with it at its designed ratio, so setting",
      "a budget re-tunes the whole family coherently. Defaults are sensible;",
      "tighter is not safer — if a surface 429s legitimate users, split the",
      "surface instead of shrinking a budget. See apps/server/src/rate-limit.ts.",
    ],
  },
  {
    id: "limits",
    title: "Cache limits — [server-only]",
    tuning: true,
    comment: ["Optional tuning. Sensible defaults are built in."],
  },
  // --- apps/web/.env ---
  {
    id: "web",
    title: "Web app (build-time, public)",
    file: "web",
    always: true,
    comment: [
      "These are BUILD-TIME client vars — they are inlined into the browser",
      "bundle and are therefore public. Never put a secret here.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const ENV_VARS: EnvVar[] = [
  // --- core ----------------------------------------------------------------
  {
    key: "DATABASE_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "PostgreSQL connection string",
    hint: "e.g. postgresql://user:password@host:5432/dbname — or leave blank to omit and set it on the platform",
    example: "postgresql://postgres:password@localhost:5432/cockpit_chess",
    exampleSet: true,
  },
  {
    key: "REDIS_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "Redis connection string",
    hint: "e.g. redis://default:password@host:6379 (BullMQ + rate limiting) — or leave blank to omit and set it on the platform",
    example: "redis://localhost:6379",
    exampleSet: true,
  },
  {
    key: "DATABASE_POOL_MAX",
    group: "core",
    source: "default",
    default: "10",
    advanced: true,
    comment: [
      "Max connections in this process's Postgres pool (node-postgres `max`).",
      "Default 10 matches the driver default — raise it only against the",
      "database's connection budget, since every server/worker replica holds its own pool.",
      "Full pooler note: docs/deployment.md",
    ],
  },

  // --- runtime -------------------------------------------------------------
  {
    key: "NODE_ENV",
    group: "runtime",
    source: "default",
    default: "development",
    choices: [{ value: "production" }, { value: "development" }, { value: "test" }],
    example: "production",
    comment: [
      "Set to `production` on every deployed environment. Several env guards",
      "escalate from a warning to a hard boot failure when this is `production`",
      "— that is intentional, do not weaken it to silence a startup error.",
    ],
  },
  {
    key: "MIGRATE_ON_START",
    group: "runtime",
    source: "default",
    inSchema: false,
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Read by scripts/docker-entrypoint.sh, not the Zod schemas. Default: true",
      "for the server command, false for every other command (the worker",
      "then waits up to 300 s and registers its instance before serving).",
      "Container platforms set false everywhere and run the `migrate` command",
      "as a one-shot job before rollout.",
    ],
  },
  {
    key: "COCKPIT_CHESS_INSTANCE_ID",
    hidden: true,
    group: "runtime",
    source: "default",
    comment: [
      "Set by the image entrypoint (a fresh UUID per container start). Never set",
      "it yourself: scheduled deletions wait for every registered older instance.",
    ],
  },
  {
    key: "BACKUP_ENABLED",
    group: "backups",
    source: "default",
    default: "true",
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Freshness monitoring only, default true. False never suppresses backup",
      "writing, pre-migrate/pre-drop snapshots or restore snapshots.",
    ],
  },
  {
    key: "PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    comment: [
      "[server-only] Injected by most platforms. Leave unset unless you are",
      "running the container by hand.",
    ],
  },
  {
    key: "SERVER_PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "3000",
    defaultFrom: "app",
    comment: [
      "[server-only] Raw local runs (`pnpm dev:raw`) and container overrides",
      "only. Leave unset for the default portless dev flow — portless injects",
      "PORT per app. The schema field is optional with no Zod default; 3000 is",
      "the fallback in apps/server/src/index.ts.",
    ],
  },

  {
    key: "WORKER_MODE",
    group: "runtime",
    source: "default",
    default: "embedded",
    comment: [
      "[server-only] embedded runs background jobs in the app (default).",
      "Set external only when deploying a dedicated worker with the same Redis/database.",
      "External mode never silently falls back; /ready fails if consumers disappear.",
    ],
  },

  {
    key: "BUILD_VERSION",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: [
      "Full Git SHA build argument; baked into BUILD_COMMIT beside the server bundle. Never a runtime commit override.",
    ],
  },

  {
    key: "CHECK_DATABASE_URL",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: [
      "Disposable PostgreSQL superuser URL for migration CI checks only; never point at application data.",
    ],
  },

  {
    key: "DEPLOY_CHECK_URL",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: [
      "Repository Actions variable: development auto-deploy origin; enables the optional deploy-check workflow.",
    ],
  },

  {
    key: "DEPLOY_CHECK_TIMEOUT",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: ["Repository Actions variable: deploy confirmation timeout in seconds, default 1800."],
  },

  {
    key: "RESTORE_DRILL",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: [
      "Internal script-to-script restore drill flag (1); never operator restore configuration.",
    ],
  },

  {
    key: "BACKUP_TEST_VERBOSE",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    comment: [
      "Optional disposable backup integration harness logging; no application runtime consumer.",
    ],
  },

  // --- auth ----------------------------------------------------------------
  {
    key: "BETTER_AUTH_SECRET",
    group: "auth",
    source: "generate",
    generator: "secret32",
    required: true,
    secret: true,
    comment: [
      "REQUIRED, minimum 32 characters. The env validator rejects weak and",
      "placeholder values in production. Rotating this invalidates every",
      "existing session — generate once per environment and keep it stable.",
      "",
      "For LOCAL dev this is filled in for you by `pnpm run setup`; to mint one",
      "by hand use `pnpm generate:secret` and paste it below. For a PRODUCTION",
      "environment prefer `pnpm generate:secrets`, which generates this along",
      "with the rest of the block and validates the result.",
    ],
  },
  {
    key: "BETTER_AUTH_URL",
    format: "origin",
    group: "auth",
    source: "prompt",
    required: true,
    prompt: "Public app origin (used by auth callbacks and for SEO URLs)",
    hint: "Origin only — no path, query, hash, or credentials. e.g. https://app.example.com",
    example: "https://cockpit-chess.localhost",
    exampleSet: true,
  },
  {
    key: "CORS_ORIGIN",
    format: "origin",
    group: "auth",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional. Set ONLY when the browser app runs on a different origin than",
      "the API (raw web dev, split-origin deploys). Leave unset for",
      "the default same-origin flow. No path, query, or hash.",
    ],
  },
  {
    key: "TRUST_PROXY_HOPS",
    advanced: true,
    group: "auth",
    source: "default",
    default: "0",
    comment: [
      "Exact number of trusted reverse proxies in front of the app, for",
      "deriving the client IP used as the anonymous rate-limit key.",
      "0 (default) keys on the socket peer and ignores X-Forwarded-For; behind",
      "a proxy that puts every client in one shared bucket. 1 behind a single",
      "proxy (the generated Dokploy config sets 1); 2 for Cloudflare -> Traefik",
      "only when Traefik trusts Cloudflare's ranges (docs/deployment.md). With",
      "N > 0 the app must be reachable only through those proxies.",
    ],
  },

  // --- admin ---------------------------------------------------------------
  {
    key: "ADMIN_EMAILS",
    group: "admin",
    source: "prompt",
    required: true,
    prompt: "Admin email addresses (comma-separated)",
    hint: "These accounts get admin privileges. Emails are trimmed and lowercased. Bootstrap-only: after provisioning, admins persist in the database and this list can be cleared. An empty list with SIGNUP_ENABLED=false (the default) only warns at boot — on a fresh install with no admin yet, nobody can become admin.",

    example: "admin@example.com,other@example.com",
  },
  {
    key: "SIGNUP_ENABLED",
    group: "admin",
    source: "confirm",
    confirmDefault: false,
    prompt: "Enable public signup",
    hint: "Leave off for internal tools. On requires SMTP below — email verification is enforced and production refuses to boot without it.",
    default: "false",
    example: "false",
    comment: [
      "DISABLED by default: account creation is rejected and the signup form is",
      "hidden — the safe default for internal tools. Set `true` for a",
      "customer-facing app, which also REQUIRES SMTP below (email verification",
      "is enforced on signup and the server refuses to boot without it).",
    ],
  },

  // --- smtp ----------------------------------------------------------------
  {
    key: "SMTP_HOST",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP host",
    hint: "e.g. smtp.resend.com, smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com",
    example: "localhost",
  },
  {
    key: "SMTP_PORT",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP port",
    hint: "587 for STARTTLS (most providers), 465 for implicit TLS, 1025 for a local mailpit sink",
    example: "1025",
  },
  {
    key: "SMTP_USER",
    group: "smtp",
    source: "prompt",
    prompt: "SMTP username (blank if your provider doesn't require auth)",
    example: "",
  },
  {
    key: "SMTP_PASS",
    group: "smtp",
    source: "prompt",
    secret: true,
    prompt: "SMTP password / API key (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_FROM",
    group: "smtp",
    source: "prompt",
    required: true,
    // Excluded from the group's reuse offer: this is the app's own From:
    // identity, so inheriting it sends the new app's mail branded as the old.
    reusable: false,
    prompt: "From: address for outgoing mail",
    hint: 'e.g. "App Name <no-reply@yourdomain.com>". Required whenever SMTP_HOST is set.',
    example: "noreply@example.com",
  },

  // --- sso -----------------------------------------------------------------
  {
    key: "SSO_ENABLED",
    group: "sso",
    // Flipped to true automatically when the SSO group is enabled — credentials
    // alone do not turn SSO on (packages/auth gates on this flag).
    source: "enable",
    default: "false",
    example: "true",
  },
  {
    key: "SSO_CLIENT_ID",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO client ID",
    example: "",
  },
  {
    key: "SSO_CLIENT_SECRET",
    group: "sso",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "SSO client secret",
    example: "",
  },
  {
    key: "SSO_ISSUER",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO issuer URL",
    hint: "e.g. https://your-org.okta.com",
    example: "https://your-org.okta.com",
  },
  {
    key: "SSO_PROVIDER_NAME",
    group: "sso",
    source: "prompt",
    default: "SSO",
    prompt: "SSO provider display name (shown on the login button)",
    hint: 'e.g. "Okta", "Entra ID", "Google Workspace"',
    example: "Okta",
  },
  {
    key: "FORCE_SSO",
    advanced: true,
    group: "sso",
    source: "default",
    default: "false",
    example: "false",
    comment: [
      "true disables password login entirely. In production this requires",
      "SSO_ENABLED plus all three SSO credentials or the server throws at boot.",
    ],
  },

  // --- cli -----------------------------------------------------------------
  {
    key: "CLI_RELEASE_REPO",
    group: "cli",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "GitHub repo that publishes the CLI releases (owner/repo)",
    example: "your-org/your-app",
  },
  {
    key: "CLI_RELEASE_GITHUB_TOKEN",
    group: "cli",
    source: "prompt",
    omittable: true,
    secret: true,
    reusable: false,
    prompt: "Read-only GitHub token for a private repo (empty for a public repo)",
    hint: "Fine-grained PAT scoped to that one repo with Contents: read. Never sent to clients.",
    example: "",
  },
  {
    key: "CLI_RELEASE_TAG",
    group: "cli",
    source: "default",
    defaultFrom: "app",
    default: "latest release",
    example: "v1.4.0",
    comment: ["Pin the served CLI to one release tag; unset serves the latest release."],
  },

  // --- backups -------------------------------------------------------------
  {
    key: "BACKUP_S3_BUCKET",
    group: "backups",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "Backup bucket name",
    hint: "Private bucket for verified plain pg_dump snapshots; use a distinct deployment prefix.",
    example: "",
  },
  {
    key: "BACKUP_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 access key ID",
    hint: "Required for dump writers. Use a GetObject/GetObjectVersion/PutObject/AbortMultipartUpload key separate from the freshness-monitor key.",
    example: "",
  },
  {
    key: "BACKUP_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 access key ID",
    hint: "ListBucket-only key for the worker freshness check; never reuse the dump read/write key.",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_S3_REGION",
    group: "backups",
    source: "prompt",
    default: "auto",
    prompt: "Backup S3 region",
    hint: '"auto" for Cloudflare R2; a real region for AWS S3',
    example: "auto",
  },
  {
    key: "BACKUP_S3_ENDPOINT",
    group: "backups",
    source: "prompt",
    prompt: "Backup S3 endpoint URL (blank for AWS S3; required for R2/MinIO/B2/Spaces)",
    example: "",
  },
  {
    key: "BACKUP_S3_PREFIX",
    hidden: true,
    group: "backups",
    source: "default",
    default: "database",
    example: "cockpit-chess/development/app.example.com/database",
    comment: [
      "Explicit object prefix; use a unique prefix for each deployment sharing a bucket.",
      "The generated Compose includes environment and host. Monitor lists exactly <prefix>/.",
    ],
  },
  {
    key: "BACKUP_S3_FORCE_PATH_STYLE",
    hidden: true,
    group: "backups",
    source: "default",
    default: "false",
    example: "false",
  },
  {
    key: "BACKUP_S3_SSE",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Leave empty for R2 and most S3-compatible providers. Set to AES256 only",
      "for AWS S3 when you want SSE-S3 on backup objects.",
    ],
  },
  {
    key: "BACKUP_MAX_AGE_HOURS",
    hidden: true,
    group: "backups",
    source: "default",
    default: "36",
    example: "36",
    comment: [
      "Backup freshness check (worker, every 6h): alert admins and flag the",
      "admin dashboard when the newest dump in BACKUP_S3_BUCKET is older than",
      "this many hours. 36 tolerates one missed nightly run; two always alert.",
    ],
  },

  {
    key: "BACKUP_SCHEDULE",
    group: "backups",
    source: "default",
    inSchema: false,
    default: "off",
    choices: [{ value: "off" }, { value: "daily" }],
    example: "off",
    comment: [
      "Read by the `backup` service of the generated Dokploy compose",
      "(scripts/backup/schedule.mjs), never by the app. `daily` turns on one",
      "verified pg_dump a day into /backups (and S3 when BACKUP_S3_BUCKET is set).",
    ],
  },

  {
    key: "BACKUP_HOUR_UTC",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    default: "3",
    example: "3",
    comment: ["Hour (0-23, UTC) of the daily backup when BACKUP_SCHEDULE=daily."],
  },

  {
    key: "BACKUP_KEEP",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    default: "14",
    example: "14",
    comment: [
      "Daily dumps kept in /backups (1-365). S3 copies are never deleted by the",
      "app: expire them with a bucket lifecycle rule.",
    ],
  },

  // --- translation ---------------------------------------------------------
  {
    key: "PUBLIC_APP_URL",
    hidden: true,
    format: "origin",
    group: "translation",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional origin metadata sent to translation providers such as",
      "OpenRouter. Not used for auth — it is declared in the shared schema, so",
      "a worker-only deploy can set it.",
    ],
  },
  {
    key: "TRANSLATION_PROVIDER",
    group: "translation",
    source: "prompt",
    default: "openrouter",
    prompt: "Translation provider",
    choices: [
      {
        value: "openrouter",
        label: "OpenRouter (default)",
        description: "Cheapest path to claude-haiku-4-5, plus multi-model access from one account",
      },
      {
        value: "anthropic",
        label: "Anthropic direct",
        description: "Calls the Anthropic API directly with ANTHROPIC_API_KEY",
      },
    ],
    example: "openrouter",
  },
  {
    key: "OPENAI_API_KEY",
    group: "translation",
    source: "manual",
    hidden: true,
    secret: true,
    example: "",
    comment: [
      "Optional direct OpenAI credential for local chess inference; never sent to the browser.",
    ],
  },
  {
    key: "OPENROUTER_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "OpenRouter API key (blank if using anthropic)",
    hint: "Required when TRANSLATION_PROVIDER=openrouter",
    example: "",
  },
  {
    key: "ANTHROPIC_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "Anthropic API key (blank if using openrouter)",
    hint: "Required when TRANSLATION_PROVIDER=anthropic",
    example: "",
  },
  {
    key: "TRANSLATION_MODEL",
    hidden: true,
    group: "translation",
    source: "manual",
    example: "anthropic/claude-haiku-4-5",
    comment: [
      "Per-call model override. Defaults to `anthropic/claude-haiku-4-5`",
      "(OpenRouter) or `claude-haiku-4-5` (Anthropic direct) when unset.",
    ],
  },

  // --- chess (tuning) -------------------------------------------------------
  {
    key: "CHESS_HOSTED_ENABLED",
    group: "chess",
    source: "default",
    default: "false",
    advanced: true,
    example: "false",
    comment: [
      "Enable admin-only hosted chess inference. Local play and public replay need no key.",
    ],
  },

  // --- ratelimit (tuning) --------------------------------------------------
  // Three named budgets, two knobs per family.
  // Family-scaling semantics: a budget describes its family's
  // REFERENCE member; every other member keeps its ratio to that reference,
  // so POINTS multiplies every member's points by (provided/reference) and
  // WINDOW_SECONDS multiplies every member's window AND block duration by the
  // same factor. Burst/sustained ratios, bucket keying, and fail-open vs
  // fail-closed stay fixed in code (packages/api/src/lib/rate-limit-families.ts
  // + apps/server/src/rate-limit.ts). Tighter is not safer — if one surface
  // 429s legitimate users, split the surface instead of shrinking a budget.
  // Full tables: apps/server/src/rate-limit.ts.
  {
    key: "RATE_LIMIT_AUTH_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "30",
    hint: "Auth family reference: requests per IP per window on the general /api/auth/* surface (password reset, verification, session ops). Setting it rescales the whole fail-closed auth family at each member's designed ratio: credential 10, credential-burst 3/10s, signup 10/h, 2FA-OTP 3/15min.",
  },
  {
    key: "RATE_LIMIT_AUTH_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the auth family reference. Scales every auth-family window AND block duration by the same factor.",
  },
  {
    key: "RATE_LIMIT_RPC_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "100",
    hint: "RPC family reference: requests per user (per IP signed out) per window on /rpc/*. /ready (60) and the SSR catch-all (300) scale with it. One batched request can carry up to ORPC_BATCH_MAX_SIZE procedures.",
  },
  {
    key: "RATE_LIMIT_RPC_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the RPC family reference; scales /ready and SSR with it.",
  },
  {
    key: "RATE_LIMIT_EMAIL_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3",
    hint: "Email family reference: mails per RECIPIENT per window on the anonymous send-mail endpoints (verification resend, password reset). Signup (6) and sign-in-triggered mails (10) scale with it. Keyed on the mailbox, so rotating IPs cannot flood one inbox. 0 disables the whole recipient family.",
  },
  {
    key: "RATE_LIMIT_EMAIL_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3600",
    hint: "Window (seconds) for the email family reference; scales all three recipient buckets with it.",
  },

  // --- limits (tuning) -----------------------------------------------------
  {
    key: "SSR_CACHE_TTL_SECONDS",
    advanced: true,
    group: "limits",
    source: "default",
    default: "60",
    comment: [
      "In-memory SSR HTML cache for anonymous GETs of public routes. 0 disables",
      "it. Public content edits can take up to this long to appear live.",
      "See apps/server/src/seo.ts.",
    ],
  },

  // --- apps/web/.env -------------------------------------------------------
  {
    key: "VITE_APP_NAME",
    group: "web",
    file: "web",
    source: "default",
    default: "App",
    // Not a Zod default: web.ts declares this `.optional()` and applies "App"
    // through a getter on the exported env object.
    defaultFrom: "app",
    example: "My Business App",
    comment: ["Used in the app shell title/header."],
  },
  {
    key: "VITE_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
    comment: [
      "API origin. Defaults to window.location.origin at runtime — leave unset",
      "for the portless/Vite proxy flow. No path, query string, or hash.",
    ],
  },
  {
    key: "VITE_DEV_PORT",
    group: "web",
    file: "web",
    source: "manual",
    example: "3001",
    comment: [
      "Raw dev-server knobs. Leave unset with portless, which assigns ports and",
      "proxies /api, /rpc, /ws. Without portless, Vite listens on",
      "3001 and proxies to 3000.",
    ],
  },
  {
    key: "VITE_DEV_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function groupsForFile(file: EnvFile): EnvGroup[] {
  return ENV_GROUPS.filter((g) => (g.file ?? "root") === file);
}

export function varsInGroup(groupId: string): EnvVar[] {
  return ENV_VARS.filter((v) => v.group === groupId);
}
