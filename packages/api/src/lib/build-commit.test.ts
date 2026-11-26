import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildCommit, sourceCodeUrl } from "./build-commit";

describe("readBuildCommit", () => {
  const dirs: string[] = [];
  const bundleIn = (content?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "build-commit-"));
    dirs.push(dir);
    if (content !== undefined) writeFileSync(path.join(dir, "BUILD_COMMIT"), content);
    return path.join(dir, "index.mjs");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the full SHA written next to the bundle", () => {
    expect(readBuildCommit(bundleIn(`${"A".repeat(40)}\n`))).toBe("a".repeat(40));
  });

  it("reports null when the file is missing, empty, or not a full SHA", () => {
    expect(readBuildCommit(bundleIn())).toBeNull();
    expect(readBuildCommit(bundleIn(""))).toBeNull();
    expect(readBuildCommit(bundleIn("abc1234"))).toBeNull();
    expect(readBuildCommit(undefined)).toBeNull();
  });
});

describe("sourceCodeUrl", () => {
  it("links the exact running commit, or the repository when it is unknown", () => {
    const sha = "b".repeat(40);
    expect(sourceCodeUrl("https://github.com/FlyCockpit/chess", sha)).toBe(
      `https://github.com/FlyCockpit/chess/tree/${sha}`,
    );
    expect(sourceCodeUrl("https://git.example.com/fork/", null)).toBe(
      "https://git.example.com/fork",
    );
  });
});
