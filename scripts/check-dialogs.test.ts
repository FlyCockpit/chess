import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIALOGS, SHELL_PAGES, signInStep } from "./browser-checks.config.ts";
import { type DialogProbe, judgeDialog, stepScript } from "./check-dialogs.ts";

const fits: DialogProbe = {
  vw: 1280,
  vh: 800,
  popup: { top: 200, bottom: 600, left: 440, right: 840 },
  scrollers: [],
  covered: [],
};

describe("judgeDialog", () => {
  it("passes a dialog that shows all of itself inside the viewport", () => {
    assert.deepEqual(judgeDialog("Create project 1280×800", fits), []);
  });

  it("fails a dialog whose popup or a box inside it scrolls", () => {
    const bad = judgeDialog("Create sandbox 390×844", {
      ...fits,
      scrollers: [{ name: "[data-slot=dialog-content]", scrollHeight: 1900, clientHeight: 780 }],
    });
    assert.equal(bad.length, 1);
    assert.match(
      bad[0] ?? "",
      /\[data-slot=dialog-content\] scrolls \(1900px of content in 780px\)/,
    );
    assert.match(bad[0] ?? "", /page or a wide side sheet/);
  });

  it("fails a dialog whose action bar or header sits on top of its fields", () => {
    const bad = judgeDialog("Create project 1280×800", {
      ...fits,
      covered: [{ bar: "action bar", what: "p", overlap: 9 }],
    });
    assert.deepEqual(bad, ["Create project 1280×800: the action bar covers 9px of p"]);
  });

  it("fails a dialog that reaches outside the viewport", () => {
    for (const popup of [
      { top: -4, bottom: 600, left: 440, right: 840 },
      { top: 200, bottom: 801, left: 440, right: 840 },
      { top: 200, bottom: 600, left: -1, right: 840 },
      { top: 200, bottom: 600, left: 440, right: 1281 },
    ])
      assert.match(judgeDialog("x", { ...fits, popup })[0] ?? "", /outside the 1280×800 viewport/);
  });

  it("fails when no dialog opened", () => {
    assert.deepEqual(judgeDialog("x", { ...fits, popup: null }), ["x: no dialog opened"]);
  });
});

describe("browser-checks.config", () => {
  it("names every dialog once, with a locale path and at least one opening step", () => {
    const names = DIALOGS.map((dialog) => dialog.name);
    assert.equal(new Set(names).size, names.length);
    for (const dialog of DIALOGS) {
      assert.match(dialog.path, /^\/[a-z]{2}-[A-Z]{2}\//);
      assert.ok(dialog.steps.length > 0, dialog.name);
    }
  });

  it("measures at least two signed-in pages for the shell loading check", () => {
    assert.ok(SHELL_PAGES.length >= 2);
    for (const page of SHELL_PAGES) assert.notEqual(page.role, "anonymous", page.name);
  });

  it("turns steps into page scripts that fail loudly when the target is missing", () => {
    assert.match(stepScript({ click: "#a" }), /querySelector\("#a"\)/);
    assert.match(stepScript({ clickText: "New project" }), /"New project"/);
    assert.match(stepScript({ clickText: "x" }), /throw new Error/);
  });
});

describe("signInStep", () => {
  const noPause = async () => {};
  /** A fake agent-browser: each eval answers with the next scripted reply (an Error is thrown). */
  const scripted = (replies: (string | Error)[]) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? "null";
    };
    return { run, calls };
  };

  it("keeps polling across the full page load a redirectTo sign-in ends in", async () => {
    const navigated = new Error(
      "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Inspected target navigated or closed",
    );
    const { run } = scripted(["null", '"/en-US/login"', navigated, '"app"']);
    assert.equal(await signInStep(run, noPause), "app");
  });

  it("reports the second-factor step", async () => {
    const { run } = scripted(['"code"']);
    assert.equal(await signInStep(run, noPause), "code");
  });

  it("gives up after 20s with the page it is stuck on", async () => {
    const replies: string[] = [];
    for (let i = 0; i < 40; i++) replies.push("null", '"/en-US/login"');
    const { run } = scripted(replies);
    assert.equal(await signInStep(run, noPause), "still on /en-US/login after 20s");
  });

  it("also looks again after a destroyed execution context", async () => {
    const destroyed = new Error(
      "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Execution context was destroyed.",
    );
    const { run } = scripted([destroyed, '"code"']);
    assert.equal(await signInStep(run, noPause), "code");
  });

  it("passes a closed browser or any other failure on at once", async () => {
    const closed = new Error(
      "agent-browser eval exited 1: Target page, context or browser has been closed",
    );
    const first = scripted([closed, '"app"']);
    await assert.rejects(signInStep(first.run, noPause), /has been closed/);
    assert.equal(first.calls.length, 1);
    const { run } = scripted([new Error("agent-browser eval exited 1: daemon not running")]);
    await assert.rejects(signInStep(run, noPause), /daemon not running/);
  });

  it("reports the navigation error, not a page, when every attempt was cut off", async () => {
    const navigated = new Error(
      "CDP error (Runtime.evaluate): Inspected target navigated or closed",
    );
    const { run } = scripted(Array.from({ length: 40 }, () => navigated));
    await assert.rejects(signInStep(run, noPause), /Inspected target navigated/);
  });

  it("never sends the probe over stdin or with a page script that outlives a navigation", async () => {
    const { run, calls } = scripted(['"app"']);
    await signInStep(run, noPause);
    assert.equal(calls[0]?.[0], "eval");
    assert.doesNotMatch(calls[0]?.[1] ?? "", /await|setTimeout/);
  });
});
