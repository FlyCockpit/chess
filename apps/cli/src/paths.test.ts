import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { configDir } from "./paths";

describe("configDir", () => {
  it("honours COCKPIT_CHESS_CONFIG_DIR everywhere", () => {
    expect(configDir({ COCKPIT_CHESS_CONFIG_DIR: "/x" }, "linux")).toBe("/x");
  });

  it("follows XDG on Linux and WSL", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(join("/xdg", "cockpit-chess"));
    expect(configDir({}, "linux")).toBe(join(homedir(), ".config", "cockpit-chess"));
  });

  it("uses Application Support on macOS and APPDATA on Windows", () => {
    expect(configDir({}, "darwin")).toBe(
      join(homedir(), "Library", "Application Support", "cockpit-chess"),
    );
    expect(configDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "cockpit-chess"),
    );
  });
});
