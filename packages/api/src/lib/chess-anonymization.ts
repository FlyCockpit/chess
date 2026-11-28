import { randomUUID } from "node:crypto";
import {
  applyUci,
  Chess,
  type MatchArchive,
  type MatchEvent,
  type Player,
  parseArchive,
  validateArchive,
} from "@cockpit-chess/chess";
import { gamePositions, storedSpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import { Prisma } from "@cockpit-chess/db";

/** Fixed export labels. Browser surfaces translate these from the anonymized flag. */
export const DELETED_USER = "Deleted user";
export const UNKNOWN_MODEL = "Unknown model";
const ANONYMIZATION_BATCH_SIZE = 50;
const NEUTRAL_SLUG = /^replay-([a-f0-9]{32})$/;

/** A public identity minted independently of every former owner/archive identifier. */
export function neutralReplayIdentity() {
  const archiveId = randomUUID();
  return { archiveId, slug: `replay-${archiveId.replaceAll("-", "")}` };
}

/** Refuse a null-owner row that never passed the retention transition. */
export function neutralArchiveId(slug: string): string | null {
  const digits = NEUTRAL_SLUG.exec(slug)?.[1];
  return digits
    ? `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
    : null;
}

function publicPlayer(player: Player, safeModelIds: ReadonlySet<string>): Player {
  if (player.protocol === "human") return { name: DELETED_USER, model: "human", protocol: "human" };
  if (player.protocol === "random") return { name: "Random", model: "random", protocol: "random" };
  const model = safeModelIds.has(player.model) ? player.model : UNKNOWN_MODEL;
  // Model catalog IDs can be longer than the display-name schema permits.
  return { name: model.slice(0, 80), model, protocol: player.protocol };
}

/**
 * Whitelist projection shared by retention and every null-owner public read/export.
 * Never return a raw archive merely because its owner FK is null. Reconstruct board
 * strings and SAN from legal moves; even a shape-valid imported string is not safe.
 * Only code-owned prompt text, settings, catalog model IDs and numerical events remain.
 */
export function anonymizeReplay(
  input: unknown,
  archiveId: string,
  safeModelIds: ReadonlySet<string> = new Set(),
): MatchArchive {
  const original = parseArchive(input);
  const board = new Chess(original.config.initialFen);
  const events: MatchEvent[] = [];
  let ply = 0;
  for (const event of original.events) {
    const base = {
      seq: events.length,
      at: event.at,
      side: board.turn(),
      ply,
    };
    switch (event.type) {
      case "tool":
      case "reply":
        break;
      case "attempt": {
        const before = board.fen();
        if (event.accepted) {
          const move = applyUci(board, event.move);
          events.push({
            ...base,
            type: "attempt",
            move: `${move.from}${move.to}${move.promotion ?? ""}`,
            accepted: true,
            before,
            fen: board.fen(),
            san: move.san,
            reason: null,
            comment: "",
          });
          ply += 1;
        } else {
          // Unparseable attempts can contain arbitrary personal text. Keep only
          // board-coordinate tokens or a constant placeholder, never the raw reply.
          const safeMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(event.move)
            ? event.move
            : "[unparseable]";
          events.push({
            ...base,
            type: "attempt",
            move: safeMove,
            accepted: false,
            before,
            fen: before,
            san: null,
            reason: event.reason,
            comment: "",
            ...(event.stopReason === "output-truncated" ? { stopReason: event.stopReason } : {}),
          });
        }
        break;
      }
      case "usage":
        events.push({ ...event, ...base, resolvedModel: null, resolvedProvider: null });
        break;
      case "evaluation":
        // The post-move evaluation contains only numerical/board values. Rebuild
        // the FEN so malicious free text cannot survive an imported field.
        events.push({
          ...event,
          ...base,
          evaluation: { ...event.evaluation, fen: board.fen() },
        });
        break;
      case "timing":
      case "shared-usage":
      case "reservation":
        events.push({ ...event, ...base });
        break;
    }
  }
  // The original pin is checked by parseArchive against the code-shipped bundle;
  // its system text cannot contain user names or custom instructions.
  const archive: MatchArchive = {
    format: "cockpit-chess/v1",
    id: archiveId,
    createdAt: original.createdAt,
    config: {
      title: DELETED_USER,
      white: publicPlayer(original.config.white, safeModelIds),
      black: publicPlayer(original.config.black, safeModelIds),
      initialFen: new Chess(original.config.initialFen).fen(),
      rules: original.config.rules,
      prompt: original.config.prompt,
    },
    source: original.source,
    status: original.status === "running" ? "stopped" : original.status,
    result: original.status === "running" ? "*" : original.result,
    termination: original.status === "running" ? "cancelled" : original.termination,
    turn: { type: "idle" },
    events,
  };
  return validateArchive(archive);
}

/** Spectator JSON is also part of public PNG/video state; only exact board positions survive. */
export function anonymizeSpectatorEvaluations(archive: MatchArchive, input: unknown) {
  const values = storedSpectatorEvaluations.parse(input);
  if (!values) return null;
  const positions = gamePositions(archive);
  return Object.fromEntries(
    Object.entries(values).filter(([ply, evaluation]) => evaluation.fen === positions[Number(ply)]),
  );
}

/**
 * One resumable D2b retention phase. Caller serializes account deletion and waits
 * for live writers before invoking this in its cleanup transaction. The conditional
 * write also refuses a publish/ownership change; it never republishes hidden rows.
 */
export async function anonymizePublishedReplayBatch(
  tx: Prisma.TransactionClient,
  userId: string,
  afterId?: string,
  safeModelIds: ReadonlySet<string> = new Set(),
) {
  const rows = await tx.chessMatch.findMany({
    where: { ownerId: userId, published: true, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: "asc" },
    take: ANONYMIZATION_BATCH_SIZE,
    select: { id: true, archive: true, spectatorEvaluations: true },
  });
  for (const row of rows) {
    const { archiveId, slug } = neutralReplayIdentity();
    const archive = anonymizeReplay(row.archive, archiveId, safeModelIds);
    await tx.chessMatch.updateMany({
      where: { id: row.id, ownerId: userId, published: true },
      data: {
        ownerId: null,
        publicId: archiveId,
        slug,
        title: DELETED_USER,
        whiteName: archive.config.white.name,
        blackName: archive.config.black.name,
        whiteModel: archive.config.white.model,
        blackModel: archive.config.black.model,
        archive,
        spectatorEvaluations:
          anonymizeSpectatorEvaluations(archive, row.spectatorEvaluations) ?? Prisma.DbNull,
        status: archive.status,
        runToken: null,
        heartbeatAt: null,
        turnType: "idle",
        turnId: null,
        turnSide: null,
        turnExpectedSeq: null,
        turnStartedAt: null,
        turnDeadline: null,
        pendingMove: Prisma.DbNull,
      },
    });
  }
  return {
    cursor: rows.at(-1)?.id ?? afterId ?? null,
    done: rows.length < ANONYMIZATION_BATCH_SIZE,
  };
}
