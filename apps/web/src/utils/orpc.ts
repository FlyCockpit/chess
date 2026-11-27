import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { ORPC_BATCH_MAX_SIZE } from "@cockpit-chess/config/orpc-batch";
import { env } from "@cockpit-chess/env/web";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  BatchLinkPlugin,
  ClientRetryPlugin,
  DedupeRequestsPlugin,
  SimpleCsrfProtectionLinkPlugin,
} from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import {
  documentIdentityEpoch,
  guardIdentityResponse,
  isDocumentQuarantined,
  isDocumentReplaced,
  withExpectedIdentity,
} from "@/lib/document-identity";

const link = new RPCLink({
  url: `${env.VITE_SERVER_URL}/rpc`,
  plugins: [
    new SimpleCsrfProtectionLinkPlugin(),
    // `maxSize` must stay in sync with the server's `BatchHandlerPlugin` —
    // pass the shared constant on both sides, never a literal. A client value
    // above the server's makes the server 413 the whole batch. See
    // `packages/config/src/orpc-batch.ts`.
    new BatchLinkPlugin({
      // After discard, inspect each procedure before resuming public reads.
      exclude: () => isDocumentReplaced(),
      groups: [{ condition: () => true, context: {} }],
      maxSize: ORPC_BATCH_MAX_SIZE,
    }),
    new DedupeRequestsPlugin({ groups: [{ condition: () => true, context: {} }] }),
    // ClientRetryPlugin only retries procedures that explicitly opt in via
    // `context: { retry: N }`. No procedure in this app opts in, so 429s are
    // never silently retried here — the global error handler in router.tsx
    // surfaces them as a friendly toast instead.
    new ClientRetryPlugin(),
  ],
  async fetch(url, options, _clientOptions, path) {
    if (isDocumentQuarantined()) return new Promise<never>(() => {});
    const startedAt = documentIdentityEpoch();
    const headers = withExpectedIdentity(url.headers);
    if (isDocumentReplaced()) {
      // The account-free page's public procedures (docs/access-matrix.md).
      // Old account actions stay blocked even if a late callback starts one.
      if (
        path.length !== 2 ||
        path[0] !== "chess" ||
        !["info", "list", "get", "leaderboard"].includes(path[1] ?? "")
      )
        return new Promise<never>(() => {});
      headers.delete("X-Expected-User");
    }
    return guardIdentityResponse(
      await fetch(url, {
        ...options,
        credentials: "include",
        headers,
      }),
      startedAt,
    );
  },
});

const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
