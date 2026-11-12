import { DEVICE_FLOW_SESSION_ORIGIN } from "@cockpit-chess/config/cli";

/** The device-authorization plugin's token endpoint (`cockpit-chess login` polls it). */
const DEVICE_TOKEN_PATH = "/device/token";

/**
 * Session-create hook data for a session minted by the device flow, or
 * `undefined` to leave the row at its default `origin` ("sign-in").
 *
 * Keyed on the endpoint path Better-Auth passes to database hooks: the token
 * endpoint is the only place a device-flow session is created, and the path is
 * the router's, not anything the client sends. The CLI surface
 * (apps/server/src/cli-session.ts) accepts only sessions tagged here.
 */
export function deviceFlowSessionData<T extends object>(
  session: T,
  context: { path?: string } | null | undefined,
): { data: T & { origin: string } } | undefined {
  if (context?.path !== DEVICE_TOKEN_PATH) return undefined;
  return { data: { ...session, origin: DEVICE_FLOW_SESSION_ORIGIN } };
}
