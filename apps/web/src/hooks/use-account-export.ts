import { env } from "@cockpit-chess/env/web";
import { useEffect, useRef, useState } from "react";
import {
  documentIdentityEpoch,
  guardIdentityResponse,
  isDocumentQuarantined,
  isDocumentReplaced,
  reportSessionRejected,
  subscribeDocumentIdentity,
  withExpectedIdentity,
} from "@/lib/document-identity";
import { signOutAndLeave } from "@/lib/explicit-sign-out";

type AccountExportFormat = "json" | "pgn";
type AccountExportIssue = "reauth" | "rateLimit" | "forbidden" | "tooLarge" | "unavailable";

class AccountExportDownloadError extends Error {
  constructor(readonly issue: AccountExportIssue) {
    super(issue);
  }
}

/** Keep private bytes inside the document identity that requested them, through body completion. */
export async function fetchAccountExport(format: AccountExportFormat, signal: AbortSignal) {
  const startedAt = documentIdentityEpoch();
  if (isDocumentReplaced() || isDocumentQuarantined())
    throw new DOMException("Cancelled", "AbortError");
  const response = await guardIdentityResponse(
    await fetch(`${env.VITE_SERVER_URL}/api/account/export?format=${format}`, {
      method: "POST",
      credentials: "include",
      headers: withExpectedIdentity({ "x-csrf-token": "orpc" }),
      signal,
    }),
    startedAt,
  );
  if (!response.ok) {
    if (response.status === 401) reportSessionRejected({ status: 401 });
    const issue: AccountExportIssue =
      response.status === 401 || response.status === 412
        ? "reauth"
        : response.status === 429
          ? "rateLimit"
          : response.status === 403
            ? "forbidden"
            : response.status === 413
              ? "tooLarge"
              : "unavailable";
    throw new AccountExportDownloadError(issue);
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  if (startedAt !== documentIdentityEpoch() || isDocumentReplaced() || isDocumentQuarantined())
    throw new DOMException("Cancelled", "AbortError");
  return blob;
}

export function useAccountExport(lang: string) {
  const [pending, setPending] = useState<AccountExportFormat | "reauth" | null>(null);
  const [issue, setIssue] = useState<AccountExportIssue | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const active = useRef<AbortController | null>(null);
  const activeEpoch = useRef(0);
  const mounted = useRef(true);
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    mounted.current = true;
    const urls = downloadUrls.current;
    const unsubscribe = subscribeDocumentIdentity(() => {
      if (
        activeEpoch.current !== documentIdentityEpoch() ||
        isDocumentReplaced() ||
        isDocumentQuarantined()
      )
        active.current?.abort();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      active.current?.abort();
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function download(format: AccountExportFormat) {
    if (active.current || pending) return;
    const controller = new AbortController();
    active.current = controller;
    const startedAt = documentIdentityEpoch();
    activeEpoch.current = startedAt;
    setPending(format);
    setIssue(null);
    setDownloaded(false);
    try {
      const blob = await fetchAccountExport(format, controller.signal);
      controller.signal.throwIfAborted();
      if (
        !mounted.current ||
        startedAt !== documentIdentityEpoch() ||
        isDocumentReplaced() ||
        isDocumentQuarantined()
      )
        return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cockpit-chess-account.${format}`;
      try {
        anchor.click();
      } finally {
        // Let the browser consume the attachment before releasing its backing bytes.
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          downloadUrls.current.delete(url);
        }, 1000);
        downloadUrls.current.set(url, timer);
      }
      setDownloaded(true);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setIssue(error instanceof AccountExportDownloadError ? error.issue : "unavailable");
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }

  async function reauthenticate() {
    if (pending) return;
    setPending("reauth");
    const result = await signOutAndLeave(
      `/${lang}/login?redirectTo=${encodeURIComponent(`/${lang}/settings`)}`,
    );
    if (!result.ok) {
      setIssue("unavailable");
      setPending(null);
    }
  }
  return { pending, issue, downloaded, download, reauthenticate };
}
