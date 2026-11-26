import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useAuthSession } from "@/hooks/use-auth-session";
import { setSessionHint } from "@/lib/session-hint";

/**
 * Keep the public pages' session-cookie hint (lib/session-hint.ts) in step
 * with the app shell's confirmed session state. The signed-in home is the
 * public arena (lib/app-home.ts), so after a sign-in on any app page (password,
 * second factor, sign-up, email code) the arena's header must offer the
 * account link at once, not after the hint goes stale. Pending and error
 * states say nothing and are ignored. Mounted once by the app shell layout.
 */
export function useSessionHintSync(): void {
  const { state } = useAuthSession();
  const queryClient = useQueryClient();
  const signedIn =
    state.status === "authenticated" ? true : state.status === "anonymous" ? false : undefined;
  useEffect(() => {
    if (signedIn !== undefined) setSessionHint(queryClient, signedIn);
  }, [queryClient, signedIn]);
}
