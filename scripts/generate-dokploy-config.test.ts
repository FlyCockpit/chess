import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateDokployCompose,
  generateDokployConfig,
  resolveGitUrl,
} from "./generate-dokploy-config.js";

const defaults = {
  environment: "development" as const,
  gitRef: "main",
  topology: "app" as const,
  url: "https://dev.example.com",
};

function block(compose: string, service: string) {
  return compose.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[a-z][a-z-]*:\n/)[0] ?? "";
}

test("server leads migrations, optional external worker waits, and every role builds one ref", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    assert.equal(config.applications.length, topology === "app" ? 1 : 2);
    const server = config.applications[0]!;
    assert.equal(server.environment.MIGRATE_ON_START, "true");
    assert.equal(server.environment.WORKER_MODE, topology === "app" ? "embedded" : "external");
    // Traefik is exactly one trusted proxy; only the HTTP server keys rate limits on it.
    assert.equal(server.environment.TRUST_PROXY_HOPS, "1");
    if (topology === "app-worker") {
      assert.equal(config.applications[1]?.environment.MIGRATE_ON_START, "false");
      assert.equal(
        (config.applications[1]?.environment as Record<string, string> | undefined)
          ?.TRUST_PROXY_HOPS,
        undefined,
      );
    }
    for (const app of config.applications) {
      assert.equal(app.customGitBranch, "main");
      assert.equal(app.autoDeploy, true);
      assert.equal(app.updateConfigSwarm.Order, "start-first");
      assert.equal(app.updateConfigSwarm.FailureAction, "rollback");
      assert.equal(app.rollbackConfigSwarm.Order, "start-first");
    }
    assert.doesNotMatch(
      JSON.stringify(config),
      /APPLY_SCHEMA|WAIT_FOR_SCHEMA|schema-apply|db-applier/,
    );
    assert.equal(config.environmentVariablesToSetOnce.BACKUP_S3_BUCKET, undefined);
    assert.equal(config.environmentVariablesToSetOnce.BACKUP_ENABLED, undefined);
    assert.equal(config.compose.environmentVariables.backup, undefined);
    assert.match(config.backupSetup, /Backups default off/);
    assert.match(config.backupSetup, /BACKUP_ENABLED=true/);
  }
});

test("production requires an immutable release and development follows main", () => {
  for (const gitRef of ["master", "feature/test", "refs/heads/main"])
    assert.throws(() => generateDokployConfig({ ...defaults, gitRef }), /follows main/);
  assert.throws(
    () => generateDokployConfig({ ...defaults, environment: "production" }),
    /immutable/,
  );
  const config = generateDokployConfig({
    ...defaults,
    environment: "production",
    gitRef: `release/${"a".repeat(40)}`,
    topology: "app-worker",
  });
  for (const app of config.applications) assert.equal(app.autoDeploy, false);
  assert.equal(new Set(config.applications.map((app) => app.customGitBranch)).size, 1);
  assert.match(config.database.name, /^cockpit-chess-production-/);
});

test("both generator entry points reject invalid origins and removed topologies", () => {
  for (const url of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com/#frag",
  ]) {
    assert.throws(() => generateDokployConfig({ ...defaults, url }));
    assert.throws(() => generateDokployCompose({ ...defaults, url }));
  }
  for (const topology of ["app-applier", "full"])
    assert.throws(
      () => generateDokployConfig({ ...defaults, topology: topology as "app" }),
      /Choose app/,
    );
});

test("writer keys stay in startup and backup, monitor keys only reach selected runtime", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const config = generateDokployConfig({ ...defaults, topology, backups: true });
    const server = config.applications[0]!;
    assert.equal(
      server.environment.BACKUP_S3_ACCESS_KEY_ID,
      `\${{environment.BACKUP_S3_ACCESS_KEY_ID}}`,
    );
    assert.equal(
      server.environment.BACKUP_S3_PREFIX,
      "cockpit-chess/development/dev.example.com/database",
    );
    // The server migrates in both topologies, so it always gets the backup
    // switch that takes its pre-migration and pre-drop dumps.
    assert.equal(server.environment.BACKUP_ENABLED, `\${{environment.BACKUP_ENABLED}}`);
    assert.match(
      block(generateDokployCompose({ ...defaults, topology, backups: true }), "server"),
      /BACKUP_ENABLED: "\$\{BACKUP_ENABLED:-false\}"/,
    );
    // The server re-ages the monitor's recorded verdict with its own
    // BACKUP_MAX_AGE_HOURS (packages/api/src/lib/backup-freshness.ts), so it
    // needs the configured limit even when a dedicated worker is the monitor.
    assert.equal(server.environment.BACKUP_MAX_AGE_HOURS, `\${{environment.BACKUP_MAX_AGE_HOURS}}`);
    assert.equal(config.environmentVariablesToSetOnce.BACKUP_MAX_AGE_HOURS, "36");
    assert.match(
      block(generateDokployCompose({ ...defaults, topology, backups: true }), "server"),
      /BACKUP_MAX_AGE_HOURS: "\$\{BACKUP_MAX_AGE_HOURS:-36\}"/,
    );
    const monitor = config.applications[topology === "app" ? 0 : 1]!;
    assert.ok(monitor.environment.BACKUP_MONITOR_S3_ACCESS_KEY_ID);
    if (topology === "app-worker") {
      assert.equal(server.environment.BACKUP_MONITOR_S3_ACCESS_KEY_ID, undefined);
      assert.equal(monitor.environment.BACKUP_S3_ACCESS_KEY_ID, undefined);
      assert.equal(monitor.environment.BETTER_AUTH_SECRET, undefined);
    }
    for (const optional of Object.values(config.optionalEnvironmentKeys)) {
      assert.ok(optional.includes("OPENROUTER_API_KEY"));
      assert.equal(
        optional.some((key) =>
          /^(BACKUP_|RESTORE_|MIGRATE_|APPLY_SCHEMA|WAIT_FOR_SCHEMA|COCKPIT_CHESS_INSTANCE_ID)/.test(
            key,
          ),
        ),
        false,
      );
    }
  }
});

test("compose DAG has one server leader, isolated storage, opt-in daily service and proxy policies", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const compose = generateDokployCompose({ ...defaults, topology, backups: true });
    assert.doesNotMatch(compose, /schema-apply|db-applier|APPLY_SCHEMA|WAIT_FOR_SCHEMA/);
    assert.doesNotMatch(compose, /^\s+(ports|container_name):/m);
    assert.match(compose, /image: postgres:18/);
    assert.match(compose, /postgres-data:\/var\/lib\/postgresql/);
    assert.match(compose, /--maxmemory-policy", "noeviction"/);
    assert.match(compose, /pg_isready -h 127\.0\.0\.1 -U \$\$\{POSTGRES_USER\}/);
    const server = block(compose, "server");
    assert.match(server, /MIGRATE_ON_START: "true"/);
    assert.match(server, /TRUST_PROXY_HOPS: "1"/);
    assert.doesNotMatch(block(compose, "worker"), /TRUST_PROXY_HOPS/);
    assert.doesNotMatch(block(compose, "backup"), /TRUST_PROXY_HOPS/);
    assert.match(server, /stop_grace_period: 30s/);
    assert.match(server, /order: start-first/);
    assert.match(server, /failure_action: rollback/);
    assert.match(server, /backups:\/backups/);
    assert.match(server, /compress\.encodings=zstd,br,gzip/);
    assert.match(server, /rule=Host\(`dev.example.com`\)/);
    assert.doesNotMatch(server, /healthcheck:/);
    const backup = block(compose, "backup");
    assert.match(backup, /profiles: \[backup\]/);
    assert.match(backup, /dockerfile: Dockerfile\n/);
    assert.match(backup, /command: backup-schedule/);
    assert.match(backup, /BACKUP_SCHEDULE: "\$\{BACKUP_SCHEDULE:-off\}"/);
    assert.match(
      backup,
      /BACKUP_S3_PREFIX: "cockpit-chess\/development\/dev.example.com\/database"/,
    );
    assert.match(backup, /backups:\/backups/);
    // The server populates the fresh shared backups volume first: backup is
    // created only after it started (no concurrent copy-up race).
    assert.match(
      backup,
      /depends_on:\n {6}postgres:\n {8}condition: service_healthy\n {6}server:\n {8}condition: service_started\n/,
    );
    assert.doesNotMatch(backup, /BETTER_AUTH_SECRET|REDIS_URL|BACKUP_MONITOR_/);
    // The image's HEALTHCHECK probes the server's HTTP listener; the scheduler
    // has none, so the service runs its own freshness probe instead.
    assert.match(
      backup,
      /healthcheck:\n {6}test: \["CMD", "node", "\/app\/scripts\/backup\/schedule\.mjs", "health"\]\n {6}interval: 5m\n {6}timeout: 30s\n {6}retries: 1\n {6}start_period: 10m\n/,
    );
    assert.doesNotMatch(backup, /disable: true/);
    if (topology === "app-worker") {
      assert.match(block(compose, "worker"), /MIGRATE_ON_START: "false"/);
      assert.doesNotMatch(
        block(compose, "worker"),
        /BACKUP_S3_ACCESS_KEY_ID|BACKUP_S3_SECRET_ACCESS_KEY/,
      );
      assert.doesNotMatch(server, /BACKUP_MONITOR_/);
    } else assert.equal(block(compose, "worker"), "");
    for (const match of compose.matchAll(
      /\$\{([A-Z0-9_]*(?:SECRET|PASSWORD|PASS)[A-Z0-9_]*):-([^}]*)\}/g,
    ))
      assert.equal(match[2], "", `${match[1]} has a secret default`);
  }
});

test("two sites have distinct project, network/volume scopes and Traefik identifiers", () => {
  const first = generateDokployCompose(defaults);
  const second = generateDokployCompose({ ...defaults, url: "https://other.example.com" });
  const name = (value: string) => value.match(/^name: (.+)$/m)?.[1];
  assert.notEqual(name(first), name(second));
  assert.notEqual(
    generateDokployConfig(defaults).applications[0]?.environment.BACKUP_S3_PREFIX,
    generateDokployConfig({ ...defaults, url: "https://other.example.com" }).applications[0]
      ?.environment.BACKUP_S3_PREFIX,
  );
  assert.match(
    second,
    /BACKUP_S3_PREFIX: "cockpit-chess\/development\/other.example.com\/database"/,
  );
  assert.notEqual(
    name(generateDokployCompose({ ...defaults, url: "https://a-b.example.com" })),
    name(generateDokployCompose({ ...defaults, url: "https://a.b.example.com" })),
  );
  assert.match(first, /cockpit-chess-development-dev-example-com-[a-f0-9]{10}-server/);
  assert.match(second, /cockpit-chess-development-other-example-com-[a-f0-9]{10}-server/);
  const production = generateDokployCompose({
    ...defaults,
    environment: "production",
    gitRef: `release/${"b".repeat(40)}`,
  });
  assert.match(
    production,
    /BACKUP_S3_PREFIX: "cockpit-chess\/production\/dev.example.com\/database"/,
  );
});

test("checklist includes the actual compose roles and optional backup setup", () => {
  const config = generateDokployConfig({ ...defaults, backups: true });
  assert.equal(config.compose.file, "docker-compose.dokploy.yml");
  assert.deepEqual(config.compose.environmentVariables.postgres, ["POSTGRES_PASSWORD"]);
  assert.ok(config.compose.environmentVariables.server?.includes("BETTER_AUTH_SECRET"));
  assert.ok(config.compose.environmentVariables.backup?.includes("BACKUP_S3_ACCESS_KEY_ID"));
  assert.match(config.compose.manualMigration, /server migrate/);
});

test("SETUP_KEY is a server-only pass-through that stays off the fill-in checklists", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    const compose = generateDokployCompose({ ...defaults, topology });
    assert.match(block(compose, "server"), /^ {6}SETUP_KEY: "\$\{SETUP_KEY:-\}"$/m);
    assert.equal(config.compose.environmentVariables.server?.includes("SETUP_KEY"), false);
    assert.equal("SETUP_KEY" in config.environmentVariablesToSetOnce, false);
    assert.ok(config.optionalEnvironmentKeys.server.includes("SETUP_KEY"));
    if (topology === "app-worker") {
      assert.doesNotMatch(block(compose, "worker"), /SETUP_KEY/);
      assert.equal(config.optionalEnvironmentKeys.worker?.includes("SETUP_KEY"), false);
    }
  }
});

test("new deployments require no backup settings, volume or sidecar", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    assert.ok(
      Object.keys(config.environmentVariablesToSetOnce).every((key) => !key.startsWith("BACKUP_")),
    );
    const compose = generateDokployCompose({ ...defaults, topology });
    assert.doesNotMatch(compose, /backups:\/backups|^ {2}backups:|^ {2}backup:/m);
    assert.doesNotMatch(compose, /BACKUP_ENABLED:/);
    const optedIn = generateDokployCompose({ ...defaults, topology, backups: true });
    assert.match(optedIn, /BACKUP_ENABLED: "\$\{BACKUP_ENABLED:-false\}"/);
    assert.match(optedIn, /backups:\/backups/);
  }
});

test("--git-url pins every build context to <url>#<git-ref>, so a pasted Compose builds without a source tree", () => {
  for (const [environment, gitRef, topology, backups, contexts] of [
    ["development", "main", "app", false, 1],
    ["production", `release/${"c".repeat(40)}`, "app-worker", true, 3],
  ] as const) {
    const options = {
      ...defaults,
      environment,
      gitRef,
      topology,
      backups,
      gitUrl: "https://github.com/example/app.git",
    };
    const compose = generateDokployCompose(options);
    const found = [...compose.matchAll(/^ {6}context: (.+)$/gm)].map((match) => match[1]);
    assert.equal(found.length, contexts, compose);
    for (const context of found)
      assert.equal(context, `"https://github.com/example/app.git#${gitRef}"`);
    // Each Git-context build keeps .git, so the server image can report its commit.
    assert.equal(
      [...compose.matchAll(/^ {8}BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"$/gm)].length,
      contexts,
      compose,
    );
    assert.doesNotMatch(compose, /context: \.$/m);
    assert.match(compose, /--git-url https:\/\/github\.com\/example\/app\.git/);
    const config = generateDokployConfig(options);
    assert.ok(
      config.compose.buildContext.startsWith(`https://github.com/example/app.git#${gitRef}: `),
      config.compose.buildContext,
    );
    for (const app of config.applications)
      assert.equal(app.customGitUrl, "https://github.com/example/app.git");
  }
  // scp-like SSH and ssh:// URLs are Git contexts too.
  for (const gitUrl of ["git@github.com:example/app.git", "ssh://git@example.com/app.git"])
    assert.match(
      generateDokployCompose({ ...defaults, gitUrl }),
      new RegExp(`context: "${gitUrl.replaceAll(".", "\\.")}#main"`),
    );
});

test("without a Git URL the context stays local and the checklist says it is not for Dokploy", () => {
  const compose = generateDokployCompose({ ...defaults, backups: true });
  assert.equal([...compose.matchAll(/^ {6}context: \.$/gm)].length, 2, compose);
  assert.match(compose, /--git-url local/);
  assert.doesNotMatch(compose, /BUILDKIT_CONTEXT_KEEP_GIT_DIR/);
  const config = generateDokployConfig(defaults);
  assert.match(config.compose.buildContext, /^local/);
  assert.match(config.applications[0]?.customGitUrl ?? "", /^<your repository URL/);
});

test("--git-url refuses credentials, fragments and characters that could break the YAML", () => {
  for (const gitUrl of [
    "https://user:token@github.com/example/app.git",
    "https://token@github.com/example/app.git",
    "ssh://git:secret@example.com/app.git",
    "https://github.com/example/app.git#main",
    "https://github.com/example/app.git?x=1",
    "git@github.com:example/app.git?x=1",
    "git@github.com:example/app.git#main",
    "http://github.com/example/app.git",
    "file:///srv/app.git",
    'https://github.com/example/"app',
    "https://github.com/example/app.git $(id)",
    "",
  ]) {
    assert.throws(() => generateDokployConfig({ ...defaults, gitUrl }), /--git-url/, gitUrl);
    assert.throws(() => generateDokployCompose({ ...defaults, gitUrl }), /--git-url/, gitUrl);
  }
});

test("resolveGitUrl: the flag, else the origin remote; local means context .; neither is an error", () => {
  assert.equal(
    resolveGitUrl("https://x.example/a.git", () => "ignored"),
    "https://x.example/a.git",
  );
  assert.equal(
    resolveGitUrl(undefined, () => "git@github.com:o/r.git\n"),
    "git@github.com:o/r.git",
  );
  assert.equal(
    resolveGitUrl("local", () => "ignored"),
    undefined,
  );
  assert.throws(() => resolveGitUrl(undefined, () => undefined), /--git-url/);
  assert.throws(() => resolveGitUrl(undefined, () => "  "), /--git-url/);
});

test("the backup healthcheck's script ships in the image it probes", () => {
  const probe = /test: \["CMD", "node", "(\/app\/[^"]+)", "health"\]/.exec(
    block(generateDokployCompose({ ...defaults, backups: true }), "backup"),
  )?.[1];
  assert.equal(probe, "/app/scripts/backup/schedule.mjs");
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  assert.match(runtime, /^WORKDIR \/app$/m);
  assert.match(
    runtime,
    /^COPY scripts\/backup\/pre-migrate\.sh \\\n(?: {5}scripts\/backup\/\S+ \\\n)* {5}scripts\/backup\/schedule\.mjs \\\n(?: {5}scripts\/backup\/\S+ \\\n)* {5}\.\/scripts\/backup\/$/m,
  );
  const schedule = readFileSync(new URL("./backup/schedule.mjs", import.meta.url), "utf8");
  assert.match(schedule, /command === "health"\) process\.exitCode = health\(\)/);
});

test("previous pepper secret is an optional server-only compose setting", () => {
  for (const topology of ["app", "app-worker"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    const compose = generateDokployCompose({ ...defaults, topology });
    assert.match(block(compose, "server"), /BETTER_AUTH_SECRET_PREVIOUS/);
    assert.doesNotMatch(block(compose, "worker"), /BETTER_AUTH_SECRET_PREVIOUS/);
    assert.doesNotMatch(
      JSON.stringify(config.environmentVariablesToSetOnce),
      /BETTER_AUTH_SECRET_PREVIOUS/,
    );
  }
});

const publicFixture = (name: string) =>
  readFileSync(new URL(`../docs/fixtures/public-hosting/${name}`, import.meta.url), "utf8");
const publicCompose = () => JSON.parse(publicFixture("compose.json"));

test("public fixture keeps one current SHA, migration leader and external consumer", () => {
  const fixture = publicCompose();
  const { server, worker, backup, postgres, redis } = fixture.services;
  assert.deepEqual(Object.keys(fixture.services).sort(), [
    "backup",
    "postgres",
    "redis",
    "server",
    "worker",
  ]);
  for (const [role, dockerfile] of [
    [server, "Dockerfile"],
    [worker, "Dockerfile.worker"],
  ] as const) {
    assert.equal(role.build.dockerfile, dockerfile);
    assert.equal(role.build.context, server.build.context);
    assert.equal(role.build.args.BUILD_VERSION, server.build.args.BUILD_VERSION);
    assert.match(role.build.context, /#\$\{CHESS_COMMIT:\?[^}]+\}$/);
    assert.match(role.image, /:\$\{CHESS_COMMIT:\?[^}]+\}$/);
    assert.equal(role.deploy.replicas, 1);
    assert.equal(role.stop_grace_period, "30s");
    assert.equal(role.healthcheck, undefined, "preserve image startup allowance");
  }
  assert.equal(backup.image, server.image);
  assert.equal(backup.command, "backup-schedule");
  assert.deepEqual(backup.profiles, ["backup"]);
  assert.equal(server.environment.MIGRATE_ON_START, "true");
  assert.equal(server.environment.WORKER_MODE, "external");
  assert.equal(worker.environment.MIGRATE_ON_START, "false");
  assert.equal(worker.environment.DATABASE_URL, server.environment.DATABASE_URL);
  assert.equal(worker.environment.REDIS_URL, server.environment.REDIS_URL);
  assert.equal(postgres.image, "postgres:18");
  assert.equal(redis.image, "valkey/valkey:9.1");
  assert.ok(redis.command.includes("noeviction"));
  assert.deepEqual(postgres.volumes, ["postgres-data:/var/lib/postgresql"]);
  assert.deepEqual(redis.volumes, ["redis-data:/data"]);
});

test("public fixture requires same-origin secrets and measured ingress without public data ports", () => {
  const fixture = publicCompose();
  const { server, worker } = fixture.services;
  assert.equal(server.environment.BETTER_AUTH_URL, "https://chess.flycockpit.app");
  assert.equal(server.environment.PUBLIC_APP_URL, server.environment.BETTER_AUTH_URL);
  assert.equal(server.environment.TRUST_PROXY_HOPS, "2");
  assert.equal(server.environment.CORS_ORIGIN, undefined);
  assert.equal(server.environment.VITE_SERVER_URL, undefined);
  assert.equal(server.environment.SIGNUP_ENABLED, `\${SIGNUP_ENABLED:-false}`);
  assert.equal(server.environment.SETUP_KEY, `\${SETUP_KEY:-}`);
  assert.equal(worker.environment.SETUP_KEY, undefined);
  assert.equal(server.environment.BETTER_AUTH_SECRET_PREVIOUS, `\${BETTER_AUTH_SECRET_PREVIOUS:-}`);
  assert.equal(worker.environment.BETTER_AUTH_SECRET_PREVIOUS, undefined);
  for (const role of [server, worker]) {
    assert.equal(role.environment.SMTP_PORT, "465");
    assert.match(role.environment.SMTP_PASS, /^\$\{SMTP_PASS:\?/);
    assert.match(role.environment.CHESS_PROVIDER_KEY_SECRET, /^\$\{CHESS_PROVIDER_KEY_SECRET:\?/);
    assert.equal(role.environment.CHESS_RUN_CONCURRENCY, "512");
    assert.equal(role.environment.CHESS_ENGINE_POOL_SIZE, "2");
    assert.equal(
      role.environment.CHESS_PROVIDER_KEY_SECRET_PREVIOUS,
      `\${CHESS_PROVIDER_KEY_SECRET_PREVIOUS:-}`,
    );
    assert.equal(role.environment.CHESS_HOSTED_ENABLED, `\${CHESS_HOSTED_ENABLED:-false}`);
    assert.equal(
      role.environment.CHESS_USER_MATCHES_ENABLED,
      `\${CHESS_USER_MATCHES_ENABLED:-false}`,
    );
    assert.equal(role.environment.OPENROUTER_API_KEY, undefined);
  }
  assert.equal(
    server.environment.CHESS_PROVIDER_KEY_SECRET,
    worker.environment.CHESS_PROVIDER_KEY_SECRET,
  );
  for (const service of Object.values(fixture.services)) {
    assert.equal(Object.hasOwn(service as object, "ports"), false);
    assert.equal(Object.hasOwn(service as object, "network_mode"), false);
  }
  assert.deepEqual(server.networks, ["default", "ingress"]);
  assert.equal(worker.networks, undefined);
  assert.equal(fixture.networks.ingress.name, "dokploy-network");
  assert.equal(server.labels["traefik.http.routers.chess-public.tls.options"], "chess-zone@file");
  assert.equal(
    server.labels["traefik.http.routers.chess-public.rule"],
    "Host(`chess.flycockpit.app`)",
  );
  assert.equal(server.labels["traefik.http.routers.chess-public.tls.certresolver"], undefined);
  const tls = JSON.parse(publicFixture("traefik-tls.json")).tls.options["chess-zone"];
  assert.equal(tls.sniStrict, true);
  assert.equal(tls.clientAuth.clientAuthType, "RequireAndVerifyClientCert");
  assert.deepEqual(tls.clientAuth.caFiles, ["/run/chess-tls/zone-client-ca.crt"]);
});

test("public fixture separates required backup writer, monitor and erasure storage", () => {
  const { server, worker, backup } = publicCompose().services;
  const prefix = "cockpit-chess/production/chess.flycockpit.app/database";
  assert.equal(backup.environment.BACKUP_SCHEDULE, "daily");
  assert.equal(backup.environment.BACKUP_KEEP, "30");
  assert.equal(backup.environment.BACKUP_HOUR_UTC, "3");
  for (const role of [server, worker]) {
    assert.equal(role.environment.BACKUP_ENABLED, "true");
    assert.equal(role.environment.BACKUP_MAX_AGE_HOURS, "26");
    assert.equal(role.environment.ACCOUNT_DELETION_REGISTER_DIR, "/account-deletions");
    assert.deepEqual(role.volumes[0], {
      type: "bind",
      source: "/srv/cockpit-chess/account-deletions",
      target: "/account-deletions",
      bind: { create_host_path: false },
    });
  }
  assert.deepEqual(server.volumes[1], backup.volumes[0]);
  assert.deepEqual(backup.volumes[0], {
    type: "volume",
    source: "backups",
    target: "/backups",
    volume: { nocopy: true },
  });
  assert.deepEqual(publicCompose().volumes.backups, {
    driver: "local",
    driver_opts: { type: "none", o: "bind", device: "/srv/cockpit-chess/backups" },
  });
  assert.notEqual(server.volumes[0].source, backup.volumes[0].source);
  for (const role of [server, worker, backup])
    assert.equal(role.environment.BACKUP_S3_PREFIX, prefix);
  for (const writer of [server, backup]) {
    assert.match(writer.environment.BACKUP_S3_ACCESS_KEY_ID, /^\$\{BACKUP_S3_ACCESS_KEY_ID:\?/);
    assert.match(
      writer.environment.BACKUP_S3_SECRET_ACCESS_KEY,
      /^\$\{BACKUP_S3_SECRET_ACCESS_KEY:\?/,
    );
    assert.equal(writer.environment.BACKUP_S3_SSE, "AES256");
    assert.equal(writer.environment.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY, undefined);
  }
  assert.match(
    worker.environment.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY,
    /^\$\{BACKUP_MONITOR_S3_SECRET_ACCESS_KEY:\?/,
  );
  assert.equal(worker.environment.BACKUP_S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(backup.environment.REDIS_URL, undefined);
  assert.equal(backup.environment.ACCOUNT_DELETION_REGISTER_DIR, "/account-deletions");
  assert.deepEqual(backup.volumes[1], { ...server.volumes[0], read_only: true });
  const lifecycle = JSON.parse(publicFixture("bucket-lifecycle.json"));
  assert.deepEqual(lifecycle.Rules, [
    {
      ID: "chess-database-expire-30-days",
      Status: "Enabled",
      Filter: { Prefix: `${prefix}/` },
      Expiration: { Days: 30 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ]);
  assert.deepEqual(JSON.parse(publicFixture("bucket-encryption.json")), {
    Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
  });
});

test("public retention is time based and excludes the external erasure register", () => {
  for (const role of Object.values(publicCompose().services)) {
    assert.deepEqual((role as { logging: object }).logging, {
      driver: "journald",
      options: { tag: "cockpit-chess-public/{{.Name}}" },
    });
  }
  const journal = publicFixture("journald.conf");
  assert.match(journal, /MaxRetentionSec=29day/);
  assert.match(journal, /MaxFileSec=1h/);
  const maintenance = publicFixture("chess-retention.service");
  assert.match(maintenance, /journalctl --rotate --vacuum-time=29d/);
  assert.match(
    maintenance,
    /find \/srv\/cockpit-chess\/backups -xdev -type f \( -name \*\.dump -o -name \*\.dump\.\* \) -mmin \+41760 -delete/,
  );
  assert.doesNotMatch(maintenance, /account-deletions|postgres-data|redis-data/);
  assert.match(publicFixture("chess-retention.timer"), /OnCalendar=hourly\nPersistent=true/);
});

test("both image builders disable tool telemetry before installation and preserve startup", () => {
  for (const dockerfile of ["Dockerfile", "Dockerfile.worker"]) {
    const source = readFileSync(new URL(`../${dockerfile}`, import.meta.url), "utf8");
    for (const key of [
      "TURBO_TELEMETRY_DISABLED",
      "CHECKPOINT_DISABLE",
      "REACT_DOCTOR_NO_TELEMETRY",
    ]) {
      const position = source.indexOf(`${key}=1`);
      assert.ok(position > source.indexOf("FROM base AS build-base"));
      assert.ok(position < source.indexOf("RUN pnpm install"));
    }
    assert.match(source, /start-period=510s/);
    assert.match(source, /ENTRYPOINT \["docker-entrypoint.sh"\]/);
  }
});

test("public maintenance expires old local dumps while preserving recent dumps and the register", () => {
  const scratch = mkdtempSync(join(tmpdir(), "chess-public-retention-"));
  try {
    const backups = join(scratch, "backups");
    const register = join(scratch, "account-deletions");
    mkdirSync(backups);
    mkdirSync(register);
    const oldDump = join(backups, "manual-old.dump");
    const recentDump = join(backups, "daily-recent.dump");
    const oldPartial = join(backups, ".manual-old.dump.partial");
    const recentPartial = join(backups, ".manual-recent.dump.partial");
    const record = join(register, "retained.json");
    for (const file of [oldDump, recentDump, oldPartial, recentPartial, record])
      writeFileSync(file, "synthetic");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    for (const file of [oldDump, oldPartial, record]) utimesSync(file, old, old);
    const command = publicFixture("chess-retention.service")
      .split("\n")
      .find((line) => line.startsWith("ExecStart=/usr/bin/find "));
    assert.ok(command);
    const args = command.slice("ExecStart=/usr/bin/find ".length).split(" ");
    assert.equal(args[0], "/srv/cockpit-chess/backups");
    args[0] = backups;
    const result = spawnSync("/usr/bin/find", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(oldDump), false);
    assert.equal(existsSync(recentDump), true);
    assert.equal(existsSync(oldPartial), false);
    assert.equal(existsSync(recentPartial), true);
    assert.equal(existsSync(record), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
