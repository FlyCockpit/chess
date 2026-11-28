import {
  isDocumentReplaced,
  onDocumentReplaced,
  withExpectedIdentity,
} from "@/lib/document-identity";
import { safeRedirectTo } from "@/utils/safe-redirect";

const CLAIM_FRAGMENT = /^#?runner-claim=([0-9a-f]{64})$/;
let continuation: { token: string; userId: string } | undefined;
let removeIdentityFence: (() => void) | undefined;

/** Claim secrets stay in fragments, never nested inside redirect query parameters. */
export function runnerClaimToken(hash: string): string | null {
  return CLAIM_FRAGMENT.exec(hash)?.[1] ?? null;
}

/** Mirror TanStack's one hash decode before applying the strict claim parser.
 * Do not feed an already-decoded router hash through another decode.
 */
function nativeRunnerClaimToken(hash: string): string | null {
  try {
    return runnerClaimToken(decodeURI(hash.startsWith("#") ? hash.slice(1) : hash));
  } catch {
    return null;
  }
}

/** Keep the continuation only in component memory, disarming document reloads. */
export function disarmRunnerClaimLink(
  token: string,
  replace: (href: string) => void,
  historyHash = "",
): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (
    nativeRunnerClaimToken(hash) !== token &&
    !(hash === "" && nativeRunnerClaimToken(historyHash) === token)
  )
    return;
  const clean = new URL(window.location.href);
  clean.hash = "";
  replace(`${clean.pathname}${clean.search}`);
}

function scrubNative(token: string): void {
  disarmRunnerClaimLink(token, (href) => {
    History.prototype.replaceState.call(window.history, window.history.state, "", href);
  });
}

/** Install before the session probe, including when enclosing layouts cannot
 * render an Outlet. Anonymous -> sign-in keeps its intended continuation;
 * replacing an already authenticated identity disarms it before reload.
 */
export function watchRunnerClaimIdentity(pathname: string, lang: string): void {
  if (
    isRunnerClaimPath(pathname, lang) ||
    normalizeClaimPath(pathname) === `/${lang}/login`.toLowerCase()
  )
    installRunnerClaimIdentityFence();
}

function installRunnerClaimIdentityFence(): void {
  if (typeof window === "undefined" || removeIdentityFence) return;
  removeIdentityFence = onDocumentReplaced(() => {
    if (!withExpectedIdentity().get("X-Expected-User")) return;
    // The strict fragment identifies claim authority wherever navigation is
    // currently paused. Discard it before replacing an authenticated account;
    // route/search parsing or an ancestor redirect cannot preserve it for B.
    const token = nativeRunnerClaimToken(window.location.hash);
    if (token) scrubNative(token);
    continuation = undefined;
  });
}

/** Document-local memory only. Called immediately after guard admission,
 * before settings, 2FA, loading or error surfaces can withhold the claim page.
 */
export function rememberRunnerClaim(
  location: { pathname: string; hash: string },
  lang: string,
  userId: string,
): void {
  if (typeof window === "undefined" || isDocumentReplaced()) return;
  if (!isRunnerClaimPath(location.pathname, lang)) {
    continuation = undefined;
    return;
  }
  const token = runnerClaimToken(location.hash);
  if (token) {
    if (continuation?.token === token && continuation.userId !== userId) return;
    continuation = { token, userId };
  } else if (location.hash || continuation?.userId !== userId) {
    continuation = undefined;
  }
  if (continuation && window.location.pathname === location.pathname)
    scrubNative(continuation.token);
}

export function rememberedRunnerClaim(userId: string): string {
  return !isDocumentReplaced() && continuation?.userId === userId
    ? `runner-claim=${continuation.token}`
    : "";
}

export function resetRunnerClaimContinuationForTests(): void {
  removeIdentityFence?.();
  removeIdentityFence = undefined;
  continuation = undefined;
}

export function isRunnerClaimPath(pathname: string, lang: string): boolean {
  return normalizeClaimPath(pathname) === `/${lang}/runner/claim`.toLowerCase();
}

function normalizeClaimPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

export function runnerClaimLoginTarget(
  location: { pathname: string; href: string; hash: string },
  lang: string,
): { redirectTo: string; hash?: string } {
  if (!isRunnerClaimPath(location.pathname, lang)) return { redirectTo: location.href };
  const token = runnerClaimToken(location.hash);
  return {
    redirectTo: `/${lang}/runner/claim`,
    ...(token ? { hash: `runner-claim=${token}` } : {}),
  };
}

/** Only the final document navigation attaches the secret; mail callbacks remain clean. */
export function runnerClaimAfterSignIn(redirectTo: unknown, lang: string, hash: string): string {
  const target = safeRedirectTo(redirectTo, lang);
  const token = runnerClaimToken(hash);
  return isRunnerClaimPath(target, lang) && token ? `${target}#runner-claim=${token}` : target;
}

// Route guards are imported before the client shell starts its identity watcher.
// Fence locale/pending ancestors too, before they can delay the auth guard.
installRunnerClaimIdentityFence();
