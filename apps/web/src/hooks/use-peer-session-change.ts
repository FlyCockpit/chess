import { useEffect } from "react";

import { onPeerSessionChange } from "@/lib/document-identity";

/**
 * Run `listener` whenever another open tab announces a session change (a
 * sign-in, a sign-out, another account: lib/document-identity.ts). Pass a
 * stable callback. docs/auth-and-routing.md § Query cache follows identity.
 */
export function usePeerSessionChange(listener: () => void): void {
  useEffect(() => onPeerSessionChange(listener), [listener]);
}
