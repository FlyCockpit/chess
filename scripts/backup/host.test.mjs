import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linuxOnlyTest } from "./linux-only.mjs";

// host.sh is Linux-only (the Dokploy server): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

const host = resolve("scripts/backup/host.sh");

/** Real bash functions, inert Docker boundary; only disposable fake credentials. */
function run(
  body,
  {
    projects = "alpha\n",
    restoreExit = "0",
    volume = "alpha-backups",
    stopExit = "0",
    stopFailOn = "",
    restoreSignal = "",
    markOnStop = false,
    input = "",
    stopSignal = "",
    gone = false,
    imageGone = false,
    registerDir = "/account-deletions",
    registerMount = "volume",
    registerSource = "alpha-deletions",
    networks = "dokploy-network alpha_default",
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "backup-host-test-"));
  const log = join(dir, "calls.log");
  // A bash script, not Node: host.sh calls docker a dozen times per run, and a
  // Node start per call was most of this file's time. Each call appends
  // "<argc>\0<arg>\0…\0<0|1>\0" and, with --env-file, "<path>\0<contents>\0"
  // (read while the process substitution is still open).
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
env_path= env_text= has_env=0 has_format=0 has_restore=0 has_guided=0
for ((index=1; index<=$#; index++)); do
  case "\${!index}" in
    --env-file) next=$((index + 1)); env_path=\${!next}; env_text=$(cat "$env_path"); has_env=1 ;;
    --format) has_format=1 ;;
    restore) has_restore=1 ;;
    --guided) has_guided=1 ;;
  esac
done
{
  printf '%s\\0' "$#" "$@" "$has_env"
  if [ "$has_env" = 1 ]; then printf '%s\\0' "$env_path" "$env_text"; fi
} >>"$HOST_TEST_LOG"
text="$*"
case "$1" in
  ps)
    if [ "$has_format" = 1 ]; then printf '%s' "$HOST_TEST_PROJECTS"
    elif [[ $text == *service=server* ]]; then echo app-server
    elif [[ $text == *service=postgres* ]]; then echo app-postgres
    else printf 'app-server\\napp-worker\\napp-backup\\napp-postgres\\napp-redis\\n'
    fi ;;
  inspect)
    format=$3 id=$4
    if [ "$format" = "{{.Image}}" ]; then echo app-image
    elif [ "$format" = "{{.Config.Image}}" ]; then echo postgres:18
    elif [[ $format == *.Mounts* && $format == *.Type* ]]; then
      if [ -n "$HOST_TEST_REGISTER_MOUNT" ]; then printf '%s\\t%s\\t%s\\n' "$HOST_TEST_REGISTER_DIR" "$HOST_TEST_REGISTER_MOUNT" "$HOST_TEST_REGISTER_SOURCE"; fi
    elif [[ $format == *.Mounts* ]]; then echo "$HOST_TEST_VOLUME"
    elif [[ $format == *.NetworkSettings* ]]; then echo "$HOST_TEST_NETWORKS"
    elif [[ $format == *.Config.Labels* ]]; then echo "\${id/app-/}"
    elif [[ $format == *.State.Running* ]]; then echo true
    elif [[ $format == *.Config.Env* ]]; then printf 'DATABASE_URL=%s\\nBACKUP_S3_BUCKET=fake-backups\\nBACKUP_S3_SECRET_ACCESS_KEY=fake-secret\\nS3_ACCESS_KEY_ID=fake-upload-key\\nUNRELATED_SECRET=must-not-pass\\nACCOUNT_DELETION_REGISTER_DIR=%s\\n' "postgresql://fake:fake@db/app" "$HOST_TEST_REGISTER_DIR"
    fi ;;
  image)
    if [ "$2" = inspect ] && [ -n "\${HOST_TEST_IMAGE_GONE:-}" ]; then
      echo "Error response from daemon: No such image: \${@: -1}" >&2
      exit 1
    fi ;;
  stop)
    # Once: the first stop (after the stop prompt) is interrupted by a signal.
    if [ -n "\${HOST_TEST_STOP_SIGNAL:-}" ] && [ ! -e "$HOST_TEST_LOG.signalled" ]; then
      : >"$HOST_TEST_LOG.signalled"
      kill -s "$HOST_TEST_STOP_SIGNAL" "$PPID"
    fi
    if [ -n "\${HOST_TEST_MARK:-}" ]; then : >"$HOST_TEST_MARK"; fi
    if [ -z "\${HOST_TEST_STOP_FAIL_ON:-}" ] || [ "\${@: -1}" = "$HOST_TEST_STOP_FAIL_ON" ]; then
      exit "$HOST_TEST_STOP_EXIT"
    fi ;;
  run)
    if [ "$has_restore" = 1 ] && [ "$has_guided" = 1 ]; then
      if [ -n "\${HOST_TEST_RESTORE_SIGNAL:-}" ]; then kill -s "$HOST_TEST_RESTORE_SIGNAL" "$PPID"; fi
      exit "$HOST_TEST_RESTORE_EXIT"
    fi ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  // Node starts children with SIGPIPE ignored; a terminal shell has it at the
  // default (fatal), so restore that before bash starts (GNU env, Linux-only).
  const result = spawnSync(
    "env",
    ["--default-signal=PIPE", "bash", "-c", 'source "$1"\n' + body, "host-test", host],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        HOST_TEST_LOG: log,
        HOST_TEST_PROJECTS: projects,
        HOST_TEST_RESTORE_EXIT: restoreExit,
        HOST_TEST_VOLUME: volume,
        HOST_TEST_STOP_EXIT: stopExit,
        HOST_TEST_STOP_SIGNAL: stopSignal,
        HOST_TEST_STOP_FAIL_ON: stopFailOn,
        HOST_TEST_RESTORE_SIGNAL: restoreSignal,
        HOST_TEST_REGISTER_DIR: registerDir,
        HOST_TEST_REGISTER_MOUNT: registerMount,
        HOST_TEST_REGISTER_SOURCE: registerSource,
        HOST_TEST_NETWORKS: networks,
        ...(markOnStop ? { HOST_TEST_MARK: join(dir, "stopped") } : {}),
        ...(gone ? { HOST_TEST_GONE: join(dir, "reader-gone") } : {}),
        ...(imageGone ? { HOST_TEST_IMAGE_GONE: "1" } : {}),
      },
      input,
      encoding: "utf8",
      timeout: 10_000,
      // A hung run's traps may hold a SIGTERM pending: never leave it behind.
      killSignal: "SIGKILL",
    },
  );
  const calls = (() => {
    let fields;
    try {
      fields = readFileSync(log, "utf8").split("\0");
    } catch {
      return [];
    }
    const parsed = [];
    let at = 0;
    while (at < fields.length - 1) {
      const count = Number(fields[at++]);
      const call = { args: fields.slice(at, at + count) };
      at += count;
      if (fields[at++] === "1") {
        call.envPath = fields[at++];
        call.env = fields[at++];
      }
      parsed.push(call);
    }
    return parsed;
  })();
  const files = readdirSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, files };
}

test("host can be sourced without discovering or changing anything", () => {
  const result = run(":");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("host rejects an unknown command and an incomplete --project before Docker", () => {
  for (const [args, message] of [
    ["unknown", /unknown command/],
    ["list --project", /needs a name/],
  ]) {
    const result = run(`main ${args}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls, []);
  }
});

test("host refuses Docker results missing compose project labels", () => {
  const result = run("main list", { projects: "\n<no value>\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no app found/);
});

test("host offers matching projects and discovers the selected container, volume and private network", () => {
  const result = run("choose_project() { pick=2; }\nmain list", {
    projects: "beta\nalpha\nalpha\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\) alpha[\s\S]*2\) beta/);
  const runCall = result.calls.find((call) => call.args[0] === "run");
  assert.ok(
    result.calls.some((call) => call.args.includes("label=com.docker.compose.project=beta")),
  );
  assert.ok(runCall.args.includes("alpha_default"));
  assert.ok(runCall.args.includes("alpha-backups:/backups"));
  assert.ok(runCall.args.includes("app-image"));
  assert.deepEqual(runCall.args.slice(-2), ["restore", "--list"]);
});

test("host forwards only backup and erasure-register settings through an --env-file process substitution", () => {
  const result = run("main backup --project alpha");
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.envPath);
  assert.match(call.envPath, /^\/(dev\/fd|proc\/self\/fd)\/\d+$/);
  assert.match(call.env, /DATABASE_URL=postgresql:\/\/fake/);
  assert.match(call.env, /BACKUP_S3_SECRET_ACCESS_KEY=fake-secret/);
  assert.match(call.env, /ACCOUNT_DELETION_REGISTER_DIR=\/account-deletions/);
  // The app upload key is not a backup setting: never forwarded.
  assert.doesNotMatch(call.env, /^S3_ACCESS_KEY_ID=/m);
  assert.doesNotMatch(call.env, /UNRELATED_SECRET/);
  assert.deepEqual(result.files.sort(), ["calls.log", "docker"]);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-secret|postgresql:/);
});

test("host requires a persistent current register before stopping writers for restore", () => {
  for (const options of [{ registerDir: "" }, { registerMount: "" }, { registerMount: "tmpfs" }]) {
    const result = run(
      "require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project alpha",
      options,
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /account.*register/);
    assert.ok(!result.calls.some((call) => ["stop", "start", "run"].includes(call.args[0])));
  }
});

test("host mounts the current register read-only for restore and drill", () => {
  for (const action of ["restore daily.dump", "drill daily.dump"]) {
    const result = run(
      `require_terminal() { return 0; }\nask() { return 0; }\nmain ${action} --project alpha`,
    );
    assert.equal(result.status, 0, result.stderr);
    const call = result.calls.find((item) => item.args.includes("--env-file"));
    assert.ok(
      call.args.includes("type=volume,source=alpha-deletions,target=/account-deletions,readonly"),
    );
    assert.match(call.env, /ACCOUNT_DELETION_REGISTER_DIR=\/account-deletions/);
  }
});

test("host starts the app again after a successful restore (stop, restore, then stop-then-start)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions
      .filter((call) => call.args[0] === "stop")
      .slice(0, 3)
      .map((call) => call.args.at(-1)),
    ["app-server", "app-worker", "app-backup"],
  );
  const restore = actions.find((call) => call.args[0] === "run");
  assert.deepEqual(restore.args.slice(-3), ["restore", "/backups/daily.dump", "--guided"]);
  // The outcome is reported on stderr (a `| tee` reader may be gone).
  assert.match(result.stderr, /Restore done/);
  assert.match(result.stderr, /pending migrations/);
  assert.doesNotMatch(result.stderr, /uncertain|nothing was changed|was rolled back/i);
});

test("host leaves all writers stopped after a restore whose outcome is uncertain (or that committed, then failed)", () => {
  for (const restoreExit of ["1", "5", "7", "130", "143"]) {
    const result = run(
      "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
      { restoreExit },
    );
    assert.equal(result.status, Number(restoreExit), result.stderr);
    const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
    assert.deepEqual(
      actions.map((call) => call.args[0]),
      ["stop", "stop", "stop", "run"],
    );
    assert.match(
      result.stderr,
      new RegExp(
        `Restore failed and its outcome is uncertain, or it committed and a later step failed \\(exit ${restoreExit}\\): the restore output above says which\\. The app stays stopped`,
      ),
    );
    assert.match(result.stderr, /Inspect the database \(bash \S+ list; the restore output above\)/);
    assert.match(result.stderr, /docker start app-server app-worker app-backup/);
    assert.doesNotMatch(
      result.stderr,
      /Nothing was restored|database is as it was|nothing was changed|Restore done|was rolled back|Started the app again/i,
    );
  }
});

test("host restarts every stopped writer when the restore failed and rolled back (exit 4)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "4" },
  );
  assert.equal(result.status, 4, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    // The restart waits for each writer's stop (idempotent) before starting it.
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-server", "app-worker", "app-backup"],
  );
  assert.match(
    result.stderr,
    /Restore failed and was rolled back; the database is unchanged[\s\S]*Started the app again/,
  );
  assert.doesNotMatch(result.stderr, /uncertain|Restore done|nothing was changed/i);
});

test("host restarts every stopped writer when the restore is cancelled or refused (exit 3)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "3" },
  );
  assert.equal(result.status, 3, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    // The restart waits for each writer's stop (idempotent) before starting it.
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-server", "app-worker", "app-backup"],
  );
  assert.match(result.stderr, /Cancelled or refused; nothing was changed/);
  assert.doesNotMatch(result.stderr, /uncertain|Restore done|was rolled back/);
});

test("host keeps writers stopped on docker run exit 125 (a wait failure can follow a started restore)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "125" },
  );
  assert.equal(result.status, 125, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start"),
    [],
  );
  assert.match(result.stderr, /uncertain, or it committed and a later step failed \(exit 125\)/);
});

test("host keeps writers stopped when restore is interrupted", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project alpha",
    { restoreSignal: "SIGTERM" },
  );
  assert.ok(result.signal === "SIGTERM" || result.status === 143);
  assert.ok(result.calls.some((call) => call.args.includes("--guided")));
  assert.ok(!result.calls.some((call) => call.args[0] === "start"));
  assert.match(result.stderr, /uncertain, or it committed and a later step failed \(exit 143\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /Nothing was restored|database is as it was/);
});

// The stop prompt's answer arrives on stdin here instead of /dev/tty; ask()'s
// own y/yes check, EOF handling and the cancel path are the real ones.
const answerFromStdin = 'read_answer() { read -r -p "$1 [y/N] " answer; }';
const declinedRestore = `require_terminal() { return 0; }\n${answerFromStdin}\nmain restore daily.dump --project alpha`;

test("host restore: declining the stop prompt (n, Enter, other text, EOF) exits 3 with the app untouched", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["no", "no\n"],
    ["empty input", "\n"],
    ["other text", "sure\n"],
    ["EOF", ""],
  ]) {
    const result = run(declinedRestore, { input });
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.ok(
      !result.calls.some((call) =>
        ["stop", "start", "run", "restart", "kill"].includes(call.args[0]),
      ),
      `${label}: ${JSON.stringify(result.calls.map((call) => call.args[0]))}`,
    );
    // The cancel is the last word, and no EXIT-trap outcome note (stderr) follows.
    assert.ok(
      result.stdout.endsWith("[app-db] Cancelled. Nothing was changed; the app was not stopped.\n"),
      `${label}: ${result.stdout}`,
    );
    assert.doesNotMatch(result.stderr, /\[app-db\]/, label);
  }
});

test("host restore: a declined stop prompt still exits 3 through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["EOF", ""],
  ]) {
    const result = run(
      `require_terminal() { return 0; }\n${answerFromStdin}\nset -o pipefail\nmain restore daily.dump --project alpha | cat\nexit $?`,
      { input },
    );
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.match(result.stdout, /Cancelled\. Nothing was changed/, label);
    assert.ok(!result.calls.some((call) => ["stop", "start", "run"].includes(call.args[0])), label);
    const piped = run(
      `require_terminal() { return 0; }\n${answerFromStdin}\nset +o pipefail\nmain restore daily.dump --project alpha | cat\nexit "\${PIPESTATUS[0]}"`,
      { input },
    );
    assert.equal(piped.status, 3, `${label} (PIPESTATUS): ${piped.stderr}`);
  }
});

test("host restore: a declined stop prompt exits 3 even when the `| tee` reader left while it waited", () => {
  // The reader leaves after the banner and closes its end of the pipe; only
  // then is the answer read, so the cancel message hits a broken pipe.
  const result = run(
    `require_terminal() { return 0; }
read_answer() { until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; read -r answer; }
main restore daily.dump --project alpha | { while read -r line; do [[ "$line" != *"asked once more"* ]] || break; done; exec 0<&-; touch "$HOST_TEST_GONE"; }
exit "\${PIPESTATUS[0]}"`,
    { input: "n\n", gone: true },
  );
  assert.equal(result.status, 3, result.stderr);
  assert.ok(!result.calls.some((call) => ["stop", "start", "run"].includes(call.args[0])));
});

const promptSignals = [
  ["SIGINT", "INT"],
  ["SIGTERM", "TERM"],
  ["SIGHUP", "HUP"],
];
// The stop prompt waits on a reader that never answers and never reaches EOF
// while this shell lives (an EOF would cancel with 3 too, hiding an ignored
// signal: the run would time out instead). The signal reaches this shell (the
// pipeline's subshell under `| cat`) while `read` blocks.
const waitForever = 'read -r answer < <(exec tail -f /dev/null --pid="$pid" 2>/dev/null)';
const signalAtPrompt = (signal) =>
  `require_terminal() { return 0; }
read_answer() { local pid=$BASHPID; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }`;

test("host restore: Ctrl-C (INT), TERM or HUP while the stop prompt waits exits 3 with the app untouched", () => {
  for (const [name, signal] of promptSignals) {
    const result = run(`${signalAtPrompt(signal)}\nmain restore daily.dump --project alpha`);
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(
      result.calls
        .map((call) => call.args[0])
        .filter((verb) => !["ps", "inspect", "image", "info", "network"].includes(verb)),
      [],
      name,
    );
    assert.ok(
      result.stdout.endsWith("[app-db] Cancelled. Nothing was changed; the app was not stopped.\n"),
      `${name}: ${result.stdout}`,
    );
    assert.doesNotMatch(result.stderr, /\[app-db\]/, name);
  }
});

test("host restore: a signal at the stop prompt still exits 3 through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [name, signal] of promptSignals) {
    for (const [mode, tail] of [
      ["pipefail", "set -o pipefail\nmain restore daily.dump --project alpha | cat\nexit $?"],
      [
        "PIPESTATUS",
        `set +o pipefail\nmain restore daily.dump --project alpha | cat\nexit "\${PIPESTATUS[0]}"`,
      ],
    ]) {
      const result = run(`${signalAtPrompt(signal)}\n${tail}`);
      assert.equal(result.status, 3, `${name} (${mode}): ${result.stderr}`);
      assert.match(result.stdout, /Cancelled\. Nothing was changed/, `${name} (${mode})`);
      assert.ok(
        !result.calls.some((call) =>
          ["stop", "start", "run", "restart", "kill"].includes(call.args[0]),
        ),
        `${name} (${mode})`,
      );
    }
  }
});

test("host restore: a signal at the stop prompt exits 3 even when a `2>&1 | tee` reader is gone", () => {
  // The reader leaves after the banner; only then does the signal arrive, so
  // both the newline (stderr) and the cancel message (stdout) hit a broken pipe.
  for (const [name, signal] of promptSignals) {
    const result = run(
      `require_terminal() { return 0; }
read_answer() { local pid=$BASHPID; until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }
main restore daily.dump --project alpha 2>&1 | { while read -r line; do [[ "$line" != *"asked once more"* ]] || break; done; exec 0<&-; touch "$HOST_TEST_GONE"; }
exit "\${PIPESTATUS[0]}"`,
      { gone: true },
    );
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.ok(!result.calls.some((call) => ["stop", "start", "run"].includes(call.args[0])), name);
  }
});

test("host restore: the stop prompt's signal traps are gone after it (the previous ones are back)", () => {
  const result = run(
    `${answerFromStdin}
trap 'echo previous-int' INT
trap - TERM
confirm_stop
trap -p INT TERM HUP`,
    { input: "y\n" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "trap -- 'echo previous-int' SIGINT\n");
});

test("host restore: a signal after the stop prompt keeps its own handling (128+n, writers started again)", () => {
  for (const [name, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    const result = run(declinedRestore, { input: "y\n", stopSignal: name });
    assert.equal(result.status, status, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.ok(!result.calls.some((call) => call.args[0] === "run"), name);
    const stopped = new Set(
      result.calls.filter((call) => call.args[0] === "stop").map((call) => call.args.at(-1)),
    );
    const started = result.calls
      .filter((call) => call.args[0] === "start")
      .map((call) => call.args.at(-1));
    assert.ok(started.length > 0, name);
    assert.deepEqual(new Set(started), stopped, name);
    assert.match(result.stderr, /Restore was not invoked; nothing was changed/, name);
    assert.doesNotMatch(result.stdout, /the app was not stopped/, name);
  }
});

test("host restore: only y / yes at the stop prompt stops the app", () => {
  for (const input of ["y\n", "Y\n", "yes\n", "YES\n"]) {
    const result = run(declinedRestore, { input });
    assert.equal(result.status, 0, `${JSON.stringify(input)}: ${result.stderr}`);
    assert.ok(
      result.calls.some((call) => call.args[0] === "stop"),
      JSON.stringify(input),
    );
    assert.ok(
      result.calls.some((call) => call.args[0] === "run" && call.args.includes("--guided")),
    );
  }
});

test("host restore refuses before stopping anything when stdin is not a terminal", () => {
  // spawnSync gives the script a pipe for stdin: the real require_terminal.
  const result = run("ask() { return 0; }\nmain restore --project alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run it in a terminal/);
  assert.ok(!result.calls.some((call) => ["stop", "run", "start"].includes(call.args[0])));
});

test("host restore | tee: a terminal on stdin alone gets docker run -it", () => {
  // stdout is a pipe here (as with `| tee log`); stdin is reported as a terminal.
  const result = run(
    "stdin_is_terminal() { return 0; }\nrequire_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const restore = result.calls.find((call) => call.args[0] === "run");
  assert.ok(restore.args.includes("-it"), restore.args.join(" "));
});

test("host starts the app again when its stdout reader dies before the restore runs (`restore | tee`, Ctrl-C)", () => {
  // The reader leaves once the first writer is stopped, like `tee` killed by
  // Ctrl-C; every later write hits a broken pipe, so the restore never runs.
  const result = run(
    'require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha | { while read -r _; do [ ! -f "$HOST_TEST_MARK" ] || break; done; }',
    { markOnStop: true },
  );
  assert.ok(!result.calls.some((call) => call.args[0] === "run"), result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-server", "app-worker", "app-backup"],
    result.stderr,
  );
});

test("host keeps the cancelled-restore restart when its stdout reader is gone (exit 3 under a dead pipe)", () => {
  const result = run(
    'require_terminal() { return 0; }\nask() { return 0; }\nsay() { :; }\nmain restore daily.dump --project alpha | { while read -r _; do [ ! -f "$HOST_TEST_MARK" ] || break; done; }',
    { markOnStop: true, restoreExit: "3" },
  );
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-server", "app-worker", "app-backup"],
    result.stderr,
  );
});

test("host supports S3-only backups without a backups volume", () => {
  const result = run("main backup --project alpha", { volume: "" });
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.args[0] === "run");
  assert.ok(!call.args.includes("-v"));
});

test("host restarts app writers even when stopping one fails", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project alpha",
    { stopExit: "8", stopFailOn: "app-worker" },
  );
  assert.equal(result.status, 8, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-server", "app-worker", "app-backup"],
  );
  assert.ok(!result.calls.some((call) => call.args[0] === "run"));
});

test("host drill uses a throwaway private network and removes its database without an env file", () => {
  const result = run(
    "main drill s3://fake-backups/database/daily.dump --etag pinned --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.args.includes("restore-drill"));
  assert.match(call.args[call.args.indexOf("--network") + 1], /^cockpit-chess-drill-/);
  assert.deepEqual(call.args.slice(-4), [
    "restore-drill",
    "s3://fake-backups/database/daily.dump",
    "--etag",
    "pinned",
  ]);
  const assignment = call.env.split("\n").filter((line) => line.startsWith("DATABASE_URL="));
  assert.equal(assignment.length, 1);
  const target = new URL(assignment[0].slice("DATABASE_URL=".length));
  assert.equal(target.hostname, "drill-db");
  assert.equal(target.pathname, "/restore_drill");
  assert.doesNotMatch(call.env, /UNRELATED_SECRET/);
  assert.deepEqual(
    result.calls.slice(-2).map((item) => item.args.slice(0, 2)),
    [
      ["rm", "-f"],
      ["network", "rm"],
    ],
  );
  assert.deepEqual(result.files.sort(), ["calls.log", "docker"]);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-secret|postgresql:/);
});

test("host prints usage with no arguments, from a file and piped into bash -s, exit 2", () => {
  const file = spawnSync("bash", [host], { encoding: "utf8" });
  assert.equal(file.status, 2, file.stderr);
  assert.match(file.stdout, /restore/);
  assert.equal(file.stderr, "");
  const piped = spawnSync("bash", ["-s"], { input: readFileSync(host, "utf8"), encoding: "utf8" });
  assert.equal(piped.status, 2, piped.stderr);
  assert.match(piped.stderr, /^Usage: bash <this script> list \| backup \| restore/);
  assert.doesNotMatch(piped.stderr, /sed:|No such file/);
});

test("host stops with the recreate command when the server's image ID is gone, and never runs the tag", () => {
  for (const command of ["list", "backup", "drill", "restore daily.dump"]) {
    const result = run(
      `require_terminal() { return 0; }\nask() { return 0; }\nmain ${command} --project alpha`,
      { imageGone: true },
    );
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /the server container's image \(app-image\) is no longer on this machine/,
    );
    assert.match(
      result.stderr,
      /cd server && docker compose -p alpha up -d --no-build --force-recreate server/,
    );
    assert.match(result.stderr, /--profile backup/);
    // Nothing was run, stopped or started: no fallback to the image's tag.
    assert.deepEqual(
      result.calls.filter((call) => ["run", "stop", "start"].includes(call.args[0])),
      [],
      command,
    );
  }
});

test("public fixture supports helper network/backup discovery and a read-only bound register", () => {
  const fixture = JSON.parse(readFileSync("docs/fixtures/public-hosting/compose.json", "utf8"));
  const project = fixture.name;
  const server = fixture.services.server;
  const register = server.volumes.find((mount) => mount.target === "/account-deletions");
  const backup = server.volumes.find((mount) => mount.target === "/backups");
  assert.equal(backup.type, "volume");
  assert.equal(fixture.networks.ingress.name, "dokploy-network");
  for (const action of ["list", "backup", "restore daily.dump", "drill daily.dump"]) {
    const result = run(
      `require_terminal() { return 0; }\nask() { return 0; }\nmain ${action} --project ${project}`,
      {
        projects: `${project}\n`,
        // Deliberately first: the helper must skip ingress before choosing DB network.
        networks: `${fixture.networks.ingress.name} ${project}_default`,
        volume: `${project}_${backup.source}`,
        registerDir: server.environment.ACCOUNT_DELETION_REGISTER_DIR,
        registerMount: register.type,
        registerSource: register.source,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const operation = result.calls.find((call) => call.args[0] === "run" && call.envPath);
    assert.ok(operation.args.includes(`${project}_${backup.source}:/backups`));
    if (!action.startsWith("drill")) {
      assert.equal(operation.args[operation.args.indexOf("--network") + 1], `${project}_default`);
    }
    if (action.startsWith("restore") || action.startsWith("drill")) {
      assert.ok(
        operation.args.includes(
          `type=bind,source=${register.source},target=${register.target},readonly`,
        ),
      );
    }
  }
});
