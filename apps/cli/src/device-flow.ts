import { CLI_CLIENT_ID } from "@cockpit-chess/config/cli";

import { CliError, ExitCode } from "./exit";
import { REQUEST_TIMEOUT_MS, withNetworkDeadline } from "./network";

// RFC 8628 device authorization against Better-Auth's deviceAuthorization
// plugin. `cockpit-chess login` requests a code, the user approves it in a signed-in
// browser at /$lang/device, and the poll returns an ordinary session token.

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

type Deps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: Deps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

async function postJson(deps: Deps, url: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
  return withNetworkDeadline(async (signal) => {
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json().catch(() => {
      signal.throwIfAborted();
      return {};
    })) as Record<string, unknown>;
    return { response, data };
  }, timeoutMs);
}

export async function requestDeviceCode(
  server: string,
  deps: Deps = defaultDeps,
): Promise<DeviceCode> {
  const { response, data } = await postJson(deps, `${server}/api/auth/device/code`, {
    client_id: CLI_CLIENT_ID,
  });
  if (response.status === 429)
    throw new CliError("Too many login attempts. Wait a minute and try again.");
  if (
    !response.ok ||
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string"
  ) {
    throw new CliError(`The server did not start a login (HTTP ${response.status}).`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete:
      typeof data.verification_uri_complete === "string"
        ? data.verification_uri_complete
        : data.verification_uri,
    expiresInSeconds: typeof data.expires_in === "number" ? data.expires_in : 600,
    intervalSeconds: typeof data.interval === "number" ? data.interval : 5,
  };
}

/** Poll until the user approves (returns the session token), denies, or the code expires. */
export async function pollForToken(
  server: string,
  code: DeviceCode,
  deps: Deps = defaultDeps,
): Promise<string> {
  const deadline = deps.now() + code.expiresInSeconds * 1000;
  let intervalMs = code.intervalSeconds * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(intervalMs, deadline - deps.now()));
    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) break;
    const { response, data } = await postJson(
      deps,
      `${server}/api/auth/device/token`,
      {
        grant_type: GRANT_TYPE,
        device_code: code.deviceCode,
        client_id: CLI_CLIENT_ID,
      },
      Math.min(REQUEST_TIMEOUT_MS, remainingMs),
    );
    if (response.ok && typeof data.access_token === "string") return data.access_token;
    if (response.status === 429) {
      intervalMs += 5000;
      continue;
    }
    switch (data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new CliError("Login was denied in the browser.", ExitCode.Unauthenticated);
      case "expired_token":
        throw new CliError(
          "The login code expired. Run `cockpit-chess login` again.",
          ExitCode.Unauthenticated,
        );
      default:
        throw new CliError(
          `Login failed (HTTP ${response.status}${data.error ? `: ${String(data.error)}` : ""}).`,
        );
    }
  }
  throw new CliError(
    "The login code expired. Run `cockpit-chess login` again.",
    ExitCode.Unauthenticated,
  );
}
