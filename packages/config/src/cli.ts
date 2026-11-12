// Constants shared by the companion CLI (`apps/cli`) and the server. This
// module must stay dependency-free: the CLI bundles it into a standalone
// binary, so importing anything server-side here would ship it to users.
// See packages/api/src/routers/cli.ts.

/**
 * The OAuth `client_id` the CLI presents to the device-authorization flow. The
 * server's `validateClient` rejects any other value, so a renamed CLI must
 * change it here (once) rather than in two places.
 */
export const CLI_CLIENT_ID = "cockpit-chess-cli";

/**
 * Prefix of every API key minted for the CLI. The CLI surface uses it to tell
 * an API key from a device-flow session token in `Authorization: Bearer …`,
 * so changing it breaks every key minted with the old prefix. Set it once,
 * during the rebrand, before any key exists.
 */
export const API_KEY_PREFIX = "cockpit_chess_";

/**
 * `Session.origin` of a session minted by the device flow (`cockpit-chess login`). The
 * CLI surface accepts no other session as a bearer; every other session keeps
 * the column default, "sign-in".
 */
export const DEVICE_FLOW_SESSION_ORIGIN = "device-flow";

/**
 * `Authorization` scheme that carries a signed install token
 * (`Authorization: Install v1.…`) on the install and download endpoints. A
 * header, not a query string, so the token stays out of URL logs; and
 * `Authorization` specifically, because curl and PowerShell drop it when the
 * download redirects to GitHub's host, where a custom header would follow.
 */
export const CLI_INSTALL_AUTH_SCHEME = "Install";

/** Base path of the CLI's oRPC surface on the API server. */
export const CLI_RPC_PREFIX = "/api/cli/rpc";

/**
 * Release-asset names the release workflow uploads and the install/update
 * endpoints serve, keyed by `<os>-<arch>` as the install scripts and
 * `cockpit-chess update` compute them. WSL is Linux.
 */
export const CLI_PLATFORMS = {
  "linux-x64": "cockpit-chess-linux-x64",
  "linux-arm64": "cockpit-chess-linux-arm64",
  "darwin-x64": "cockpit-chess-darwin-x64",
  "darwin-arm64": "cockpit-chess-darwin-arm64",
  "windows-x64": "cockpit-chess-windows-x64.exe",
} as const;

export type CliPlatform = keyof typeof CLI_PLATFORMS;

/** Checksum manifest uploaded next to the binaries (`sha256sum` format). */
export const CLI_CHECKSUMS_ASSET = "SHA256SUMS";
