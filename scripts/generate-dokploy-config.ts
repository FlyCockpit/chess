/** Generate a reviewable native-Git setup. No network, credentials, or writes. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serverVars } from "../packages/env/src/vars/server.js";
import { sharedVars } from "../packages/env/src/vars/shared.js";
import { ENV_VARS } from "./lib/env-manifest.js";

type Topology = "app" | "app-worker";
type Options = {
  environment: "development" | "production";
  gitRef: string;
  topology: Topology;
  url: string;
};
const keys = new Set(ENV_VARS.map((variable) => variable.key));
const sharedKeys = new Set(Object.keys(sharedVars));
const serverKeys = new Set([...sharedKeys, ...Object.keys(serverVars)]);

export function generateDokployConfig(options: Options) {
  if (!["development", "production"].includes(options.environment))
    throw new Error("Choose development or production.");
  if (!["app", "app-worker"].includes(options.topology))
    throw new Error("Choose app or app-worker.");
  if (options.environment === "development" && options.gitRef !== "main")
    throw new Error("Development automatic deployment follows main.");
  if (options.environment === "production" && !/^release\/[a-f0-9]{40}$/.test(options.gitRef))
    throw new Error("Production requires an immutable release/<full-commit-sha> Git tag.");
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("URL must be an HTTPS origin without credentials, query, or path.");
  const worker = options.topology === "app-worker";
  const prefix = `cockpit-chess/${options.environment}/${new URL(options.url).host}/database`;
  const reference = (key: string) => {
    if (!keys.has(key)) throw new Error(`Environment manifest is missing ${key}.`);
    return `\${{environment.${key}}}`;
  };
  const refs = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, reference(name)]));
  const runtime = refs(["DATABASE_URL", "REDIS_URL"]);
  const serverEnvironment = {
    ...runtime,
    ...refs([
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "ADMIN_EMAILS",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
    ]),
    NODE_ENV: "production",
    WORKER_MODE: worker ? "external" : "embedded",
    MIGRATE_ON_START: "true",
    // Dokploy's Traefik is the one proxy in front of the server; it appends
    // the client address to X-Forwarded-For. Add one per extra proxy (e.g.
    // Cloudflare in front of Traefik is 2). See apps/server/src/client-ip.ts.
    TRUST_PROXY_HOPS: "1",
    BACKUP_S3_PREFIX: prefix,
    ...refs(writerKeys),
    ...(!worker ? refs(monitorKeys) : {}),
  };
  const workerEnvironment = {
    ...runtime,
    NODE_ENV: "production",
    MIGRATE_ON_START: "false",
    BACKUP_S3_PREFIX: prefix,
    ...refs(monitorKeys),
  };
  const application = (role: string, dockerfile: string, environment: Record<string, string>) => ({
    name: `${projectName(options)}-${role}`,
    sourceType: "git",
    customGitUrl: "<your repository URL; configure its Git credentials in Dokploy>",
    customGitBranch: options.gitRef,
    autoDeploy: options.environment === "development",
    buildType: "dockerfile",
    dockerfile,
    dockerContextPath: ".",
    createEnvFile: false,
    modeSwarm: { Replicated: { Replicas: 1 } },
    restartPolicySwarm: { Condition: "on-failure" },
    // Dokploy defaults to these when unset. A partial saved object replaces
    // those defaults, so the checklist spells out the complete runtime policy.
    updateConfigSwarm: { Parallelism: 1, Order: "start-first", FailureAction: "rollback" },
    rollbackConfigSwarm: { Parallelism: 1, Order: "start-first" },
    stopGracePeriodSwarm: 30_000_000_000,
    environment,
    domain: role === "server" ? { host: url.hostname, port: 3000, https: true } : null,
  });
  const applications = [application("server", "Dockerfile", serverEnvironment)];
  if (worker) applications.push(application("worker", "Dockerfile.worker", workerEnvironment));
  const required = [
    ...new Set(
      applications.flatMap((app) =>
        Object.values(app.environment).flatMap((value) => {
          const match = /^\$\{\{environment\.([A-Z0-9_]+)\}\}$/.exec(value);
          return match ? [match[1]!] : [];
        }),
      ),
    ),
  ];
  // Derive optional runtime inventory from the declarations + manifest. An
  // optional credential is never granted to every role just because it exists.
  const excluded = /^(RESTORE_|WORKER_MODE|MIGRATE_ON_START|COCKPIT_CHESS_INSTANCE_ID|BACKUP_)/;
  const optionalFor = (allowed: Set<string>, mapped: Record<string, string>) =>
    ENV_VARS.filter(
      (variable) =>
        allowed.has(variable.key) &&
        !Object.hasOwn(mapped, variable.key) &&
        !excluded.test(variable.key),
    ).map((variable) => variable.key);
  return {
    format: "Dokploy settings checklist; not an import or API payload",
    environment: options.environment,
    topology: options.topology,
    compose: composeChecklist(options),
    database: { name: `${projectName(options)}-postgres`, sharedWithOtherEnvironments: false },
    redis: {
      name: `${projectName(options)}-redis`,
      sharedWithOtherEnvironments: false,
      maxmemoryPolicy: "noeviction",
    },
    environmentVariablesToSetOnce: Object.fromEntries(
      required.map((key) => [
        key,
        key === "BETTER_AUTH_URL"
          ? url.origin
          : key.startsWith("BACKUP_")
            ? (backupDefaults[key] ?? "")
            : `<set ${key} for ${options.environment}; complete literal value, no nested references>`,
      ]),
    ),
    applications,
    optionalEnvironmentKeys: {
      server: optionalFor(serverKeys, serverEnvironment),
      ...(worker ? { worker: optionalFor(sharedKeys, workerEnvironment) } : {}),
    },
    backupSetupRequired:
      "Before storing real data, choose provider backups or enable exactly one daily backup service and external missed-backup alert. Daily defaults off. Fresh empty installs need no snapshot; existing databases without a destination warn; configured backup failures block. BACKUP_ENABLED controls monitor intent only (default true). Writer credentials belong to server startup and the backup service and are stripped before app execution; monitor credentials belong only to the selected worker runtime. Follow docs/deployment.md.",
    rolloutContract:
      "The server applies committed migrations before HTTP startup; external workers wait up to 300s and register their instance. Start-first orders tasks, not cross-Application completion. Accept the expected commit and readiness with deploy:check; preserve adjacent-release queue compatibility.",
    releaseContract:
      options.environment === "development"
        ? "Git builds may finish in any order. Migration history, checksums and contract admission guard startup."
        : "Disable automatic deployment. Select the same immutable Git tag for every role, deploy the server leader first, then external workers, and run the deployment verifier.",
  };
}

// Compose service names remain stable for scripts/backup/host.sh discovery.
// Project identity includes the validated hostname so two sites in one environment
// have separate networks, volumes and Traefik identifiers.
function projectName(options: Options): string {
  const url = new URL(options.url);
  const host = url.hostname
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase()
    .slice(0, 36);
  const hash = createHash("sha256").update(url.origin).digest("hex").slice(0, 10);
  return `cockpit-chess-${options.environment}-${host}-${hash}`;
}

const writerKeys = [
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_S3_REGION",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_FORCE_PATH_STYLE",
  "BACKUP_S3_SSE",
];
const monitorKeys = [
  "BACKUP_ENABLED",
  "BACKUP_MAX_AGE_HOURS",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_REGION",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_FORCE_PATH_STYLE",
  "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
  "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
];
const backupDefaults: Record<string, string> = {
  BACKUP_ENABLED: "true",
  BACKUP_MAX_AGE_HOURS: "36",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_FORCE_PATH_STYLE: "false",
};
const composeVar = (name: string, fallback = "") => `\${${name}:-${fallback}}`;
const databaseUrl = `postgresql://\${POSTGRES_USER:-cockpit_chess}:\${POSTGRES_PASSWORD:-}@postgres:5432/\${POSTGRES_DB:-cockpit_chess}`;
const redisUrl = `redis://:\${REDIS_PASSWORD:-}@redis:6379`;
const refsForCompose = (names: string[]) =>
  Object.fromEntries(names.map((key) => [key, composeVar(key, backupDefaults[key] ?? "")]));

function composeEnvironments(options: Options): Record<string, Record<string, string>> {
  const worker = options.topology === "app-worker";
  const common = { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, NODE_ENV: "production" };
  const prefix = `cockpit-chess/${options.environment}/${new URL(options.url).host}/database`;
  return {
    postgres: {
      POSTGRES_USER: composeVar("POSTGRES_USER", "cockpit_chess"),
      POSTGRES_PASSWORD: composeVar("POSTGRES_PASSWORD"),
      POSTGRES_DB: composeVar("POSTGRES_DB", "cockpit_chess"),
    },
    redis: { REDIS_PASSWORD: composeVar("REDIS_PASSWORD") },
    server: {
      ...common,
      ...refsForCompose([
        "BETTER_AUTH_SECRET",
        "ADMIN_EMAILS",
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASS",
        "SMTP_FROM",
      ]),
      SMTP_PORT: composeVar("SMTP_PORT", "587"),
      BETTER_AUTH_URL: new URL(options.url).origin,
      WORKER_MODE: worker ? "external" : "embedded",
      MIGRATE_ON_START: "true",
      // One trusted proxy (Traefik); see apps/server/src/client-ip.ts.
      TRUST_PROXY_HOPS: "1",
      ...refsForCompose(writerKeys),
      ...(!worker ? refsForCompose(monitorKeys) : {}),
      BACKUP_S3_PREFIX: prefix,
    },
    ...(worker
      ? {
          worker: {
            ...common,
            ...refsForCompose(["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]),
            SMTP_PORT: composeVar("SMTP_PORT", "587"),
            MIGRATE_ON_START: "false",
            ...refsForCompose(monitorKeys),
            BACKUP_S3_PREFIX: prefix,
          },
        }
      : {}),
    backup: {
      DATABASE_URL: databaseUrl,
      ...refsForCompose(writerKeys),
      BACKUP_S3_PREFIX: prefix,
      BACKUP_SCHEDULE: composeVar("BACKUP_SCHEDULE", "off"),
      BACKUP_HOUR_UTC: composeVar("BACKUP_HOUR_UTC", "3"),
      BACKUP_KEEP: composeVar("BACKUP_KEEP", "14"),
    },
  };
}

function composeChecklist(options: Options) {
  return {
    file: "docker-compose.dokploy.yml",
    topology: options.topology,
    import:
      "Import the generated Compose in the connected Git project; every role builds the selected Git ref.",
    environmentVariables: Object.fromEntries(
      Object.entries(composeEnvironments(options)).map(([role, entries]) => [
        role,
        [
          ...new Set(
            Object.values(entries).flatMap((value) =>
              [...value.matchAll(/\$\{([A-Z0-9_]+):-\}/g)].map((match) => match[1]!),
            ),
          ),
        ].sort(),
      ]),
    ),
    manualMigration: "docker compose run --rm server migrate",
    backups:
      "The backup profile is opt-in; enable it and set BACKUP_SCHEDULE=daily, or use provider backups. Mount /backups on server and backup. Exactly one schedule per database; BACKUP_ENABLED is monitor intent only.",
  };
}

/** Generate a project-isolated server-led deployment with an optional backup profile. */
export function generateDokployCompose(options: Options): string {
  generateDokployConfig(options); // Validate both public entry points identically.
  const project = projectName(options);
  const router = `${project}-server`;
  const envs = composeEnvironments(options);
  const envLines = (role: string) =>
    Object.entries(envs[role] ?? {})
      .map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`)
      .join("\n");
  const runtime = (role: "server" | "worker") => `  ${role}:
    build:
      context: .
      dockerfile: ${role === "server" ? "Dockerfile" : "Dockerfile.worker"}
      args:
        BUILD_VERSION: \${BUILD_VERSION:-}
    restart: unless-stopped
    stop_grace_period: 30s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
${envLines(role)}
${
  role === "server"
    ? `    volumes:
      - backups:/backups
    labels:
${[
  "traefik.enable=true",
  `traefik.http.routers.${router}.rule=Host(\`${new URL(options.url).hostname}\`)`,
  `traefik.http.routers.${router}.entrypoints=websecure`,
  `traefik.http.routers.${router}.tls.certresolver=letsencrypt`,
  `traefik.http.services.${router}.loadbalancer.server.port=3000`,
  `traefik.http.middlewares.${router}-compress.compress=true`,
  `traefik.http.middlewares.${router}-compress.compress.encodings=zstd,br,gzip`,
  `traefik.http.routers.${router}.middlewares=${router}-compress`,
]
  .map((value) => `      - ${JSON.stringify(value)}`)
  .join("\n")}
    networks:
      - default
      - dokploy
`
    : ""
}    deploy:
      replicas: 1
      update_config:
        parallelism: 1
        order: start-first
        failure_action: rollback
      rollback_config:
        parallelism: 1
        order: start-first
      restart_policy:
        condition: on-failure
`;
  return `# Generated from the connected Git ref ${options.gitRef}; do not commit this artifact.
# Server-led migrations; external workers wait before starting consumers.
# Daily backups default off. Before real data, choose provider backups or enable
# the backup profile with BACKUP_SCHEDULE=daily. Exactly one schedule per DB.
# Writer keys are stripped after server startup; monitor uses its own read-only keys.
name: ${project}

services:
  postgres:
    image: postgres:18
    restart: unless-stopped
    environment:
${envLines("postgres")}
    volumes:
      - postgres-data:/var/lib/postgresql
    healthcheck:
      test: pg_isready -h 127.0.0.1 -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
  redis:
    image: valkey/valkey:9.1
    restart: unless-stopped
    command: ["valkey-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction", "--requirepass", "\${REDIS_PASSWORD:-}"]
    environment:
${envLines("redis")}
    volumes:
      - redis-data:/data
    healthcheck:
      test: valkey-cli --no-auth-warning -a "$\${REDIS_PASSWORD}" ping
      interval: 10s
      timeout: 5s
      retries: 5
${runtime("server")}${options.topology === "app-worker" ? runtime("worker") : ""}
  backup:
    profiles: [backup]
    build:
      context: .
      dockerfile: Dockerfile
      args:
        BUILD_VERSION: \${BUILD_VERSION:-}
    command: backup-schedule
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
${envLines("backup")}
    volumes:
      - backups:/backups
    # A scheduler has no HTTP listener; do not inherit the server probe.
    healthcheck:
      disable: true

volumes:
  postgres-data:
  redis-data:
  backups:
networks:
  default:
    driver: bridge
  dokploy:
    name: dokploy-network
    external: true
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const fields: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        !["--environment", "--git-ref", "--topology", "--url"].includes(key) ||
        fields[key] ||
        !value ||
        value.startsWith("--")
      )
        throw new Error(
          "Use --environment development|production --git-ref <ref> --topology app|app-worker --url <https-origin>.",
        );
      fields[key] = value;
    }
    const options = {
      environment: fields["--environment"],
      gitRef: fields["--git-ref"],
      topology: fields["--topology"] || "app",
      url: fields["--url"],
    };
    if (!options.environment || !options.gitRef || !options.url)
      throw new Error("--environment, --git-ref, and --url are required.");
    const composePath = fileURLToPath(new URL("../docker-compose.dokploy.yml", import.meta.url));
    writeFileSync(composePath, generateDokployCompose(options as Options));
    console.error(
      `[dokploy] wrote ${relative(process.cwd(), composePath)} — a gitignored artifact. Import it in Dokploy (Compose) and fill the variables the checklist lists under "compose".`,
    );
    console.log(JSON.stringify(generateDokployConfig(options as Options), null, 2));
  } catch (error) {
    console.error(
      error instanceof TypeError
        ? "Invalid configuration URL."
        : error instanceof Error
          ? error.message
          : "Invalid configuration.",
    );
    process.exitCode = 1;
  }
}
