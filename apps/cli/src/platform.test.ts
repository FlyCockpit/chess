import { describe, expect, it } from "vitest";

import { currentPlatform } from "./platform";

describe("currentPlatform", () => {
  it("maps supported OS/arch pairs to release assets", () => {
    expect(currentPlatform("linux", "x64")).toBe("linux-x64");
    expect(currentPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("win32", "x64")).toBe("windows-x64");
  });

  it("serves the x64 build to Windows on ARM", () => {
    expect(currentPlatform("win32", "arm64")).toBe("windows-x64");
  });

  it("returns null when no build exists", () => {
    expect(currentPlatform("freebsd", "x64")).toBeNull();
    expect(currentPlatform("linux", "ia32")).toBeNull();
  });
});
