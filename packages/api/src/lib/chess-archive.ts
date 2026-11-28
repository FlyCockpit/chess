import { finishMatch, parseArchive } from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";

const storedEnding = endingSummarySchema.nullable().catch(null);

/** Stored snapshots are shape-checked; authoritative terminal row state wins. */
export function readStoredArchive(input: unknown, status?: string, ending?: unknown) {
  const archive = parseArchive(input);
  if (status === "stopped") finishMatch(archive, "*", "cancelled", "stopped");
  const parsedEnding =
    status === "error" && ending !== undefined ? storedEnding.parse(ending) : null;
  if (status === "error" && parsedEnding?.kind === "credential-revoked") {
    finishMatch(archive, "*", "credential-revoked", "error");
  } else if (status === "error" && archive.status === "running") {
    finishMatch(archive, "*", "interrupted", "error");
  }
  return archive;
}
