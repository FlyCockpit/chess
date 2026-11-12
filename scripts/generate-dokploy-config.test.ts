import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDokployCompose, generateDokployConfig } from "./generate-dokploy-config.js";

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
    assert.equal(config.environmentVariablesToSetOnce.BACKUP_S3_BUCKET, "");
    assert.equal(config.environmentVariablesToSetOnce.BACKUP_ENABLED, "true");
    assert.match(config.backupSetupRequired, /Daily defaults off/);
    assert.match(config.backupSetupRequired, /monitor intent only/);
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
    const config = generateDokployConfig({ ...defaults, topology });
    const server = config.applications[0]!;
    assert.equal(
      server.environment.BACKUP_S3_ACCESS_KEY_ID,
      `\${{environment.BACKUP_S3_ACCESS_KEY_ID}}`,
    );
    assert.equal(
      server.environment.BACKUP_S3_PREFIX,
      "cockpit-chess/development/dev.example.com/database",
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
    const compose = generateDokployCompose({ ...defaults, topology });
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
    assert.doesNotMatch(backup, /BETTER_AUTH_SECRET|REDIS_URL|BACKUP_MONITOR_/);
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
  const config = generateDokployConfig(defaults);
  assert.equal(config.compose.file, "docker-compose.dokploy.yml");
  assert.deepEqual(config.compose.environmentVariables.postgres, ["POSTGRES_PASSWORD"]);
  assert.ok(config.compose.environmentVariables.server?.includes("BETTER_AUTH_SECRET"));
  assert.ok(config.compose.environmentVariables.backup?.includes("BACKUP_S3_ACCESS_KEY_ID"));
  assert.match(config.compose.manualMigration, /server migrate/);
});
