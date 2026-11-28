import { homedir } from "node:os";
import { join } from "node:path";
import { finishMatch } from "@cockpit-chess/chess";
import { openRunnerJournal, type RunnerJournal, type RunnerJournalRecord } from "./runner-journal";
import { openRunnerSpend } from "./runner-spend";

/** All paths originate locally. Spend authority precedes journal authority in every caller. */
export async function recoverRunner(options: {
  authorityId: string;
  resolve: boolean;
  /** Test-only local storage seams. */
  spendFile?: string;
  journalRoot?: string;
  afterAbandon?: () => Promise<void>;
  now?: () => number;
}) {
  const spend = await openRunnerSpend({
    authorityId: options.authorityId,
    file: options.spendFile,
    recovery: true,
    now: options.now,
  });
  let journal: RunnerJournal | undefined;
  try {
    journal = await openRunnerJournal(
      "local-spending-authority",
      options.authorityId,
      options.journalRoot ?? join(homedir(), ".cockpit-chess"),
    );
    if (!journal.inspect) throw new Error("RUNNER_RECOVERY_STORAGE");
    const inventory = await journal.inspect();
    const snapshot = spend.recoverySnapshot();
    const unsettled = snapshot.records.filter((record) => !record.settled);
    const affected = new Set(unsettled.map((record) => record.matchId));
    for (const { matchId, phase } of inventory) if (phase === "uncertain") affected.add(matchId);
    const result = {
      version: 1,
      blocked: snapshot.blocked,
      resolved: false,
      requests: unsettled,
      games: inventory
        .filter(({ matchId }) => affected.has(matchId))
        .map(({ matchId, phase }) => ({ matchId, phase })),
    };
    if (!options.resolve) return result;
    if (snapshot.blocked) throw new Error("RUNNER_RECOVERY_BLOCKED");
    // Every abandonment is durable before resolving ANY spend. Mid-recovery death
    // leaves unsettled spend or an uncertain journal as the restart fence. Re-entry
    // repeats the same terminal state; no refund, timestamp update or inference.
    const resolvedGames: { matchId: string; phase: RunnerJournalRecord["phase"] }[] = [];
    for (const matchId of affected) {
      const record = await journal.load(matchId);
      if (!record || record.phase === "cancelled") {
        await journal.save(matchId, { phase: "cancelled" });
      } else if (record.phase !== "terminal") {
        if (record.archive.status === "running")
          finishMatch(record.archive, "*", "interrupted", "error");
        await journal.save(matchId, { ...record, phase: "terminal" });
      }
      resolvedGames.push({
        matchId,
        phase: !record || record.phase === "cancelled" ? "cancelled" : "terminal",
      });
    }
    await options.afterAbandon?.();
    await spend.resolveUncertain();
    result.resolved = true;
    result.requests = unsettled.map((record) => ({ ...record, settled: true }));
    result.games = resolvedGames;
    return result;
  } finally {
    // Do not release spend until journal has stopped all local writes.
    try {
      await journal?.close();
    } finally {
      await spend.close();
    }
  }
}
