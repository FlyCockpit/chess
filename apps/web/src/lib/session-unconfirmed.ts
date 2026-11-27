import { createContext, createElement, type ReactNode, useContext } from "react";

/** True inside a subtree that must not show who is signed in yet. */
const SessionUnconfirmedContext = createContext(false);

/**
 * Renders its subtree as if the session were still being checked, so
 * `useAuthSession()` reports `pending` there whatever Better Auth's atom
 * holds. The `_app` shell's pending state uses it: it paints before the
 * session guards (`resolveRouteSession`) have admitted anyone, and a document
 * entering the app from a public page can still hold the previous account's
 * session in the atom (another tab switched accounts meanwhile). The account
 * menu and nav show their pending state instead of that account.
 * docs/auth-and-routing.md § Query cache follows identity.
 */
export function SessionUnconfirmed({ children }: { children: ReactNode }) {
  return createElement(SessionUnconfirmedContext.Provider, { value: true }, children);
}

export function useSessionUnconfirmed(): boolean {
  return useContext(SessionUnconfirmedContext);
}
