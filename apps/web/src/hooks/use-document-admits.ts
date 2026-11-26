import { useSyncExternalStore } from "react";

import { documentAdmits, subscribeDocumentIdentity } from "@/lib/document-identity";

/**
 * True once `identity` is confirmed as the one this document's private state
 * belongs to (`lib/document-identity.ts`), by a session guard or the root
 * watcher. Private UI that no session guard covers (the public Studio tab)
 * shows and fetches the signed-in user's data only then, so it never reads a
 * cache the previous account filled before anything was watching.
 */
export function useDocumentAdmits(identity: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeDocumentIdentity,
    () => identity !== undefined && documentAdmits(identity),
    () => false,
  );
}
