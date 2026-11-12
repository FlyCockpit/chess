import { describe, expect, it } from "vitest";

import { compareVersions, parseChecksums, sha256Hex } from "./release";

describe("parseChecksums", () => {
  it("reads sha256sum output, including binary-mode markers and CRLF", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseChecksums(
      `${a}  cockpit-chess-linux-x64\r\n${b} *cockpit-chess-windows-x64.exe\n\njunk line\n`,
    );
    expect(sums.get("cockpit-chess-linux-x64")).toBe(a);
    expect(sums.get("cockpit-chess-windows-x64.exe")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });
});

it("hashes bytes as lowercase hex", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

describe("compareVersions", () => {
  it("orders numerically, ignoring a leading v and build metadata", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build.7", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.4")).toBe(-1);
  });

  it("puts a pre-release before its release, in SemVer order", () => {
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBe(1);
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.2")).toBe(-1);
    expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBe(1);
    expect(compareVersions("1.2.3-alpha", "1.2.3-alpha.1")).toBe(-1);
    expect(compareVersions("1.2.3-1", "1.2.3-alpha")).toBe(-1);
    expect(compareVersions("1.2.3-beta", "1.2.3-alpha")).toBe(1);
  });
});
