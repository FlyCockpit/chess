// Type-only: the router's TYPES give an end-to-end typed client, while none of
// the server code is bundled into the binary (`verbatimModuleSyntax` erases
// this import). A value import from @cockpit-chess/api here would ship server code
// to users — api.test.ts guards it.
import type { CliRouterClient } from "@cockpit-chess/api/routers/cli";
import { CLI_RPC_PREFIX } from "@cockpit-chess/config/cli";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { t } from "./chess-i18n";
import type { StoredCredential } from "./config";
import { CliError, ExitCode } from "./exit";
import { REQUEST_TIMEOUT_MS, withNetworkDeadline } from "./network";
import { VERSION } from "./version";

export function createApiClient(
  server: string,
  credential: StoredCredential | undefined,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const link = new RPCLink({
    url: `${server}${CLI_RPC_PREFIX}`,
    fetch: (request, init) =>
      withNetworkDeadline(
        async (signal) => {
          const response = await fetch(request, { ...init, signal });
          // CLI procedures return finite bodies. Consume them under the same
          // deadline so headers or a trickling body cannot keep a call alive.
          const body = response.body ? await response.arrayBuffer() : null;
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        timeoutMs,
        request.signal,
      ),
    headers: () => ({
      "user-agent": `cockpit-chess/${VERSION}`,
      ...(credential ? { authorization: `Bearer ${credential.value}` } : {}),
    }),
  });
  const client: CliRouterClient = createORPCClient(link);
  return client;
}

/** Turn transport and oRPC errors into one-line CLI errors with stable exit codes. */
export function toCliError(error: unknown, server: string): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "TimeoutError")
    return new CliError(t("cli:networkTimeout", { server }));
  if (error instanceof ORPCError) {
    if (error.code === "UNAUTHORIZED") {
      return new CliError(
        "Not signed in, or your session expired. Run `cockpit-chess login`.",
        ExitCode.Unauthenticated,
      );
    }
    if (error.code === "FORBIDDEN") return new CliError(error.message || "Not allowed.");
    if (error.code === "NOT_FOUND")
      return new CliError(error.message || "Not found.", ExitCode.NotFound);
    if (error.code === "TOO_MANY_REQUESTS")
      return new CliError("Rate limited by the server. Try again shortly.");
    return new CliError(error.message || `Server error (${error.code}).`);
  }
  if (error instanceof TypeError) {
    return new CliError(`Could not reach ${server}: ${error.message}`);
  }
  return new CliError(error instanceof Error ? error.message : String(error));
}
