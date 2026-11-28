import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { readSessionIdentity, useAuthSession } from "@/hooks/use-auth-session";
import {
  disarmRunnerClaimLink,
  rememberedRunnerClaim,
  runnerClaimToken,
} from "@/lib/runner-claim-link";
import { orpc } from "@/utils/orpc";

/** An explicit new fragment selects a new attempt. Removing the URL secret
 * retains the current attempt in memory, while a fresh document has no token.
 */
export function useSelectedRunnerClaim(hash: string): string {
  const previous = useRef(hash);
  const selected = hash || previous.current;
  useLayoutEffect(() => {
    previous.current = selected;
  }, [selected]);
  return selected;
}

export function useRunnerClaimDisarm(userId: string): void {
  const router = useRouter();
  useLayoutEffect(() => {
    const token = runnerClaimToken(rememberedRunnerClaim(userId));
    if (token) {
      disarmRunnerClaimLink(
        token,
        (href) => {
          router.history.replace(href, router.history.location.state, { ignoreBlocker: true });
          router.history.flush();
        },
        router.history.location.hash,
      );
    }
  });
}

/** A claim never follows a cached/refetching identity or changes its original account. */
export function useRunnerClaim(hash: string, originalUserId: string) {
  const [token] = useState(() => runnerClaimToken(hash));
  const auth = useAuthSession();
  const attempted = useRef(false);
  const mutation = useMutation(orpc.cliAccess.runners.claim.mutationOptions());
  const { mutate, isPending, isSuccess, error, reset } = mutation;
  const userId = auth.state.status === "authenticated" ? auth.state.session.user.id : null;
  const settled =
    userId === originalUserId &&
    !auth.meta.isRefetching &&
    !auth.meta.isDegraded &&
    !auth.meta.isOffline;

  useEffect(() => {
    if (!token || !settled || readSessionIdentity() !== originalUserId || attempted.current) return;
    attempted.current = true;
    mutate({ token });
  }, [token, settled, originalUserId, mutate]);

  return {
    valid: token !== null,
    isPending: isPending || (!isSuccess && !error && settled),
    isSuccess,
    error,
    retry: () => {
      // Retrying an interrupted POST is safe only for this document's original account.
      if (!token || !settled || readSessionIdentity() !== originalUserId) return;
      reset();
      mutate({ token });
    },
  };
}
