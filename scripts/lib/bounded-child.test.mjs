import assert from "node:assert/strict";
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

test("a native client ignoring TERM is killed and reaped before cancellation completes", async () => {
  const abort = new AbortController();
  const owner = boundedChild(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ],
    {
      signal: abort.signal,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  owner.child.stdout.once("data", () => abort.abort());
  await assert.rejects(owner.done);
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
