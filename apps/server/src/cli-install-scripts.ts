import {
  CLI_CHECKSUMS_ASSET,
  CLI_INSTALL_AUTH_SCHEME,
  CLI_PLATFORMS,
} from "@cockpit-chess/config/cli";

// The install/update scripts behind the copy-paste command on
// /$lang/settings/cli. Running the same command again updates in place, and
// `cockpit-chess update` does the same thing from inside the binary.
//
// Both scripts: detect OS/arch (WSL is Linux), download the binary and
// SHA256SUMS through this server's /api/cli/download endpoint (which redirects
// to a short-lived GitHub URL), verify the checksum, and install atomically
// into a per-user directory. No sudo, no admin rights.
//
// INJECTION SAFETY: the only interpolated values are `base` (from
// BETTER_AUTH_URL, a validated origin) and `token`, which the route verifies
// as a well-formed signed install token AND re-checks against SAFE_VALUE here.
// Never interpolate anything else into these templates.
//
// The token is sent as `Authorization: Install <token>`, never in a URL, so
// it stays out of access logs. curl and PowerShell both drop `Authorization`
// when the download redirects to GitHub's host, so it never leaves this app.

const SAFE_VALUE = /^[A-Za-z0-9._:/-]+$/;

function assertSafe(value: string, label: string): string {
  if (!SAFE_VALUE.test(value)) throw new Error(`Unsafe ${label} for install script`);
  return value;
}

export function installShellScript({ base, token }: { base: string; token: string }): string {
  const safeBase = assertSafe(base, "base");
  const safeToken = assertSafe(token, "token");
  return `#!/bin/sh
# cockpit-chess installer and updater. Re-run this command at any time to update.
set -eu

BASE='${safeBase}/api/cli'
TOKEN='${safeToken}'
INSTALL_DIR="\${COCKPIT_CHESS_INSTALL_DIR:-$HOME/.local/bin}"

fail() { printf 'cockpit-chess install: %s\\n' "$1" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported OS $(uname -s). On Windows, use the PowerShell command instead." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU architecture $(uname -m)" ;;
esac
# An x64 shell under Rosetta on Apple Silicon still gets the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="cockpit-chess-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset..."
AUTH="Authorization: ${CLI_INSTALL_AUTH_SCHEME} $TOKEN"
curl -fsSL -H "$AUTH" "$BASE/download/$asset" -o "$tmp/$asset" || fail "download failed. The command may have expired; copy a fresh one from the app's settings."
curl -fsSL -H "$AUTH" "$BASE/download/${CLI_CHECKSUMS_ASSET}" -o "$tmp/${CLI_CHECKSUMS_ASSET}" || fail "checksum download failed"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/${CLI_CHECKSUMS_ASSET}")"
[ -n "$expected" ] || fail "no checksum published for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset; refusing to install"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
# Copy next to the target, then rename: atomic on one filesystem, and safe
# while an older cockpit-chess is running.
cp "$tmp/$asset" "$INSTALL_DIR/.cockpit-chess.new"
mv -f "$INSTALL_DIR/.cockpit-chess.new" "$INSTALL_DIR/cockpit-chess"

"$INSTALL_DIR/cockpit-chess" config set server '${safeBase}' >/dev/null 2>&1 || true
echo "Installed $("$INSTALL_DIR/cockpit-chess" --version) to $INSTALL_DIR/cockpit-chess"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to your PATH, e.g.: echo 'export PATH=\\"$INSTALL_DIR:\\$PATH\\"' >> ~/.profile" ;;
esac
echo "Next: cockpit-chess login"
`;
}

export function installPowerShellScript({ base, token }: { base: string; token: string }): string {
  const safeBase = assertSafe(base, "base");
  const safeToken = assertSafe(token, "token");
  return `# cockpit-chess installer and updater. Re-run this command at any time to update.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Base = '${safeBase}/api/cli'
$Token = '${safeToken}'
# ARM64 Windows runs the x64 build under emulation.
$Asset = '${CLI_PLATFORMS["windows-x64"]}'
$Dir = if ($env:COCKPIT_CHESS_INSTALL_DIR) { $env:COCKPIT_CHESS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\cockpit-chess' }
$Target = Join-Path $Dir 'cockpit-chess.exe'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $Dir, $Tmp | Out-Null

try {
  Write-Host "Downloading $Asset..."
  try {
    $Auth = @{ Authorization = "${CLI_INSTALL_AUTH_SCHEME} $Token" }
    Invoke-WebRequest -UseBasicParsing -Headers $Auth -Uri "$Base/download/$Asset" -OutFile (Join-Path $Tmp $Asset)
    Invoke-WebRequest -UseBasicParsing -Headers $Auth -Uri "$Base/download/${CLI_CHECKSUMS_ASSET}" -OutFile (Join-Path $Tmp '${CLI_CHECKSUMS_ASSET}')
  } catch {
    throw "Download failed. The command may have expired; copy a fresh one from the app's settings."
  }

  $Expected = Get-Content (Join-Path $Tmp '${CLI_CHECKSUMS_ASSET}') |
    ForEach-Object { $Parts = $_ -split '\\s+'; if ($Parts[1] -eq $Asset -or $Parts[1] -eq "*$Asset") { $Parts[0].ToLower() } } |
    Select-Object -First 1
  if (-not $Expected) { throw "No checksum published for $Asset" }
  $Actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $Tmp $Asset)).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset; refusing to install" }

  # A running .exe cannot be overwritten but can be renamed.
  if (Test-Path $Target) { Move-Item -Force $Target "$Target.old" }
  Move-Item -Force (Join-Path $Tmp $Asset) $Target
  Remove-Item -Force "$Target.old" -ErrorAction SilentlyContinue

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($UserPath -split ';') -contains $Dir)) {
    $NewPath = (@($UserPath, $Dir) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    Write-Host "Added $Dir to your PATH. Open a new terminal to use cockpit-chess."
  }

  & $Target config set server '${safeBase}' | Out-Null
  Write-Host "Installed $(& $Target --version) to $Target"
  Write-Host 'Next: cockpit-chess login'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
`;
}

/** What the install command prints when its token is missing, forged, or expired. */
export function expiredInstallShellScript(settingsUrl: string): string {
  return `#!/bin/sh
echo "cockpit-chess install: this install command has expired or is invalid." >&2
echo "Copy a fresh one from ${assertSafe(settingsUrl, "settings URL")}" >&2
exit 1
`;
}

export function expiredInstallPowerShellScript(settingsUrl: string): string {
  return `Write-Error "cockpit-chess install: this install command has expired or is invalid. Copy a fresh one from ${assertSafe(settingsUrl, "settings URL")}"
`;
}
