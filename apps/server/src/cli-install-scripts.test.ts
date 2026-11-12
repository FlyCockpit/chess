import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  expiredInstallPowerShellScript,
  expiredInstallShellScript,
  installPowerShellScript,
  installShellScript,
} from "./cli-install-scripts";

const base = "https://api.example.com";
const token = "v1.eyJ1IjoidXNlci0xIn0.c2lnbmF0dXJl";

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

describe("install scripts", () => {
  it("embeds the API base and token in the shell script", () => {
    const script = installShellScript({ base, token });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`BASE='${base}/api/cli'`);
    expect(script).toContain(`TOKEN='${token}'`);
    expect(script).toContain("config set server 'https://api.example.com'");
    expect(script).toContain("SHA256SUMS");
  });

  it("embeds the API base and token in the PowerShell script", () => {
    const script = installPowerShellScript({ base, token });
    expect(script).toContain(`$Base = '${base}/api/cli'`);
    expect(script).toContain(`$Token = '${token}'`);
    expect(script).toContain("cockpit-chess-windows-x64.exe");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
  });

  it.each([
    "abc'def",
    'abc"def',
    "abc$def",
    "abc`def",
    "abc\ndef",
    "abc;rm -rf ~",
    "abc def",
    "$(id)",
  ])("refuses to interpolate an unsafe value: %j", (bad) => {
    for (const render of [installShellScript, installPowerShellScript]) {
      expect(() => render({ base, token: bad })).toThrow(/Unsafe/);
      expect(() => render({ base: `https://x.test/${bad}`, token })).toThrow(/Unsafe/);
    }
    expect(() => expiredInstallShellScript(`https://x.test/${bad}`)).toThrow(/Unsafe/);
    expect(() => expiredInstallPowerShellScript(`https://x.test/${bad}`)).toThrow(/Unsafe/);
  });

  it("explains an expired command and exits non-zero", () => {
    const script = expiredInstallShellScript("https://app.example.com/settings/cli");
    expect(script).toContain("https://app.example.com/settings/cli");
    expect(script).toMatch(/exit 1\n$/);
    expect(expiredInstallPowerShellScript("https://app.example.com/settings/cli")).toContain(
      "Write-Error",
    );
  });

  it.skipIf(!hasSh)("renders shell scripts that `sh -n` parses", () => {
    for (const script of [
      installShellScript({ base, token }),
      expiredInstallShellScript("https://app.example.com/settings/cli"),
    ]) {
      const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  it.skipIf(!hasSh)("prints the expired message and fails when run", () => {
    const result = spawnSync("sh", [], {
      input: expiredInstallShellScript("https://app.example.com/settings/cli"),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expired or is invalid");
  });
});

// Runs the real rendered installer end to end against stub `curl` / `uname`
// on PATH, so a quoting or logic slip in the template fails here rather than
// on a user's machine. POSIX only (needs sh + sha256sum or shasum).
const hasSha = spawnSync("sh", ["-c", "command -v sha256sum || command -v shasum"]).status === 0;

describe.skipIf(!hasSh || !hasSha || process.platform === "win32")("install.sh end to end", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup({ checksum }: { checksum: "good" | "bad" | "missing" }) {
    dir = mkdtempSync(join(tmpdir(), "cockpit-chess-install-"));
    const bin = join(dir, "bin");
    const fixtures = join(dir, "fixtures");
    mkdirSync(bin);
    mkdirSync(fixtures);

    // The "binary": answers --version and records `config set` calls.
    const binary = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\necho "$@" >> "${dir}/calls"\n`;
    writeFileSync(join(fixtures, "cockpit-chess-linux-x64"), binary);
    const sum = createHash("sha256").update(binary).digest("hex");
    const sums =
      checksum === "missing"
        ? `${sum}  cockpit-chess-darwin-arm64\n`
        : `${checksum === "good" ? sum : "0".repeat(64)}  cockpit-chess-linux-x64\n`;
    writeFileSync(join(fixtures, "SHA256SUMS"), sums);

    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n');
    // curl -fsSL -H <header> <url> -o <file>: log the header and URL, copy
    // the matching fixture.
    stub(
      "curl",
      `url=""; out=""; hdr=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -H) hdr="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done\necho "$hdr $url" >> "${dir}/urls"\nname="\${url##*/}"\ncp "${fixtures}/$name" "$out"\n`,
    );
    return { bin, installDir: join(dir, "install") };
  }

  function run(installDir: string, bin: string) {
    return spawnSync("sh", [], {
      input: installShellScript({ base, token }),
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        COCKPIT_CHESS_INSTALL_DIR: installDir,
      },
    });
  }

  it("downloads through the API with the token in a header, verifies, and installs", () => {
    const { bin, installDir } = setup({ checksum: "good" });
    const result = run(installDir, bin);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed 9.9.9 to ${installDir}/cockpit-chess`);
    expect(readFileSync(join(dir, "urls"), "utf8").trim().split("\n")).toEqual([
      `Authorization: Install ${token} ${base}/api/cli/download/cockpit-chess-linux-x64`,
      `Authorization: Install ${token} ${base}/api/cli/download/SHA256SUMS`,
    ]);
    expect(readFileSync(join(dir, "calls"), "utf8").trim()).toBe(`config set server ${base}`);
  });

  it("refuses to install on a checksum mismatch", () => {
    const { bin, installDir } = setup({ checksum: "bad" });
    const result = run(installDir, bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(spawnSync("test", ["-e", join(installDir, "cockpit-chess")]).status).not.toBe(0);
  });

  it("refuses to install when no checksum is published", () => {
    const { bin, installDir } = setup({ checksum: "missing" });
    const result = run(installDir, bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no checksum published");
  });
});
