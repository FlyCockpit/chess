import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { boundedChild } from "./bounded-child.mjs";

test("natural supervisor errors cannot acknowledge a child before it closes", async () => {
  const owner = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let settled = false;
  const done = owner.done.catch(() => {
    settled = true;
  });
  owner.child.emit("error", new Error("inert signal delivery error"));
  await new Promise(setImmediate);
  assert.equal(settled, false);
  owner.stop();
  await done;
  assert.notEqual(owner.child.signalCode, null);
});

test("native client success, failure, pre-start cancellation and timed cancellation", async () => {
  await boundedChild(process.execPath, ["-e", "process.exit(0)"], { timeout: 2_000 }).done;
  await assert.rejects(boundedChild(process.execPath, ["-e", "process.exit(1)"]).done);
  assert.throws(
    () => boundedChild(process.execPath, [], { signal: AbortSignal.abort() }),
    /before start/,
  );
  const owner = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeout: 100,
  });
  await assert.rejects(owner.done);
  assert.ok(owner.child.signalCode);
});

// Bounded: with no escalation the child would outlive the test forever.
test("a native client ignoring TERM is killed and reaped before cancellation completes", {
  timeout: 10_000,
}, async (t) => {
  // The production 5 s escalation runs on a mocked clock; the child, its
  // signals and its close stay real. The child reports each SIGTERM it ignores
  // and answers every stdin line, so the test knows TERM was delivered and that
  // the child is still alive just before the escalation is due.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const owner = boundedChild(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM', () => process.stdout.write('term\\n'));",
        "process.stdin.on('data', () => process.stdout.write('alive\\n'));",
        "process.stdout.write('ready\\n');",
      ].join(" "),
    ],
    { signal: abort.signal, stdio: ["pipe", "pipe", "ignore"] },
  );
  // A failed or timed-out run must not leave the TERM-ignoring child behind.
  t.after(() => {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill("SIGKILL");
  });
  const queue = [];
  let waiting;
  const deliver = (line) => {
    if (waiting) waiting(line);
    else queue.push(line);
    waiting = undefined;
  };
  createInterface({ input: owner.child.stdout })
    .on("line", deliver)
    .on("close", () => deliver("closed"));
  const next = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift())
      : new Promise((resolveLine) => {
          waiting = resolveLine;
        });
  assert.equal(await next(), "ready");
  abort.abort();
  assert.equal(await next(), "term");
  t.mock.timers.tick(4_999);
  owner.child.stdin.write("ping\n");
  assert.equal(await next(), "alive", "SIGKILL must wait for the full 5 s escalation");
  t.mock.timers.tick(1);
  await assert.rejects(owner.done, { code: "CHILD_CANCELLED" });
  assert.equal(owner.child.signalCode, "SIGKILL");
});

test("native CLI-requested stop preserves its reason and uses the owned native handle", async () => {
  const owner = boundedChild(
    process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  owner.child.kill = () => {
    throw new Error("adapter wrapper must not intercept owned termination");
  };
  owner.child.stdout.once("data", () => owner.stop("CHILD_CLI_STOP", "SIGKILL"));
  await assert.rejects(owner.done, { code: "CHILD_CLI_STOP", signal: "SIGKILL", exitCode: null });
});
