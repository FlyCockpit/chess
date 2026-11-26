import { endingText, type MatchEnding, matchEnding } from "./ending";
import {
  type AttemptEvent,
  Chess,
  DEFAULT_POSITION,
  type MatchArchive,
  type Player,
  type Rules,
  remarkTone,
  sideClockMs,
} from "./index";

/**
 * A PGN tag value: one line, no control characters, `\` and `"` escaped (PGN standard
 * 8.1.1), cut so the whole `[Name "value"]` line stays within 255 characters, the
 * standard's line and string limit. `name` is the tag it goes into.
 */
export function pgnTagValue(value: string, name = "") {
  const limit = 255 - (name.length + 5);
  let out = "";
  let length = 0;
  for (const char of value.replace(/[\p{Cc}]+/gu, " ").trim()) {
    const escaped = char === "\\" || char === '"' ? `\\${char}` : char;
    length += escaped === char ? 1 : 2;
    if (length > limit) break;
    out += escaped;
  }
  return out;
}
/**
 * A brace comment's text. Brace comments cannot contain `}` and have no escape
 * (PGN standard 5), so it becomes `)`; line breaks and control characters become
 * spaces, which also keeps a `%` escape line from ever starting inside a comment.
 */
export function pgnCommentText(value: string) {
  return value
    .replace(/\}/g, ")")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}
/** PGN `TimeControl` (standard 9.6): "-" untimed, "600" sudden death, "?" when the sides differ. */
function timeControlTag(match: MatchArchive) {
  const white = sideClockMs(match.config.rules, "w");
  const black = sideClockMs(match.config.rules, "b");
  if (white === null || black === null) return "-";
  return white === black ? String(Math.round(white / 1000)) : "?";
}
/** PGN `Termination` (standard 9.8.1) for each archive termination. */
export function pgnTermination(termination: MatchArchive["termination"]) {
  switch (termination) {
    case "checkmate":
    case "draw":
    case "resignation":
      return "normal";
    case "timeout":
    case "move-timeout":
      return "time forfeit";
    case "illegal-forfeit":
      return "rules infraction";
    case "token-budget":
    case "cost-budget":
    case "ply-limit":
      return "adjudication";
    case "cancelled":
      return "abandoned";
    case "interrupted":
    case "provider-error":
    case "engine-error":
    case "event-limit":
      return "emergency";
    case "playing":
      return "unterminated";
  }
}
/**
 * The ruleset as one tag per rule, `Cockpit` + the rule's name (`[CockpitRemarks
 * "trash-talk"]`, `[CockpitClock "w:600000,b:600000"]`): every value is an enum, a
 * number or null, so each tag stays far below the standard's 255-character string limit.
 */
export function rulesTags(rules: Rules): Array<[string, string]> {
  return Object.entries(rules).map(([key, value]) => [
    `Cockpit${key[0]?.toUpperCase()}${key.slice(1)}`,
    value === null
      ? "none"
      : typeof value === "object"
        ? Object.entries(value)
            .map(([name, entry]) => `${name}:${entry}`)
            .join(",")
        : String(value),
  ]);
}
const playerType = (player: Player) => (player.protocol === "human" ? "human" : "program");
const pgnDate = (iso: string) => iso.slice(0, 10).replace(/-/g, ".");
/** "White rejected: d2d4 (illegal), d2d3 (illegal) — remark": a remark only with remarks on. */
const rejectedText = (attempts: AttemptEvent[], remarks: boolean) =>
  `${attempts[0]?.side === "w" ? "White" : "Black"} rejected: ${attempts
    .map((attempt) => {
      const remark = remarks ? pgnCommentText(attempt.comment) : "";
      return `${attempt.move.slice(0, 32)} (${attempt.reason})${remark ? ` — ${remark}` : ""}`;
    })
    .join(", ")}`;

export type PgnOptions = {
  /** `[Site]`: the instance's public origin; defaults to "Cockpit Chess". */
  site?: string;
  /** Renders the closing comment; defaults to the English `endingText`. */
  describeEnding?: (ending: MatchEnding) => string;
};
/**
 * The match as PGN: the seven-tag roster plus player types, time control, termination
 * and the ruleset; each move's remark as a comment after it; rejected attempts as a
 * comment before the move they preceded; the ending in words before the result.
 */
export function exportPgn(match: MatchArchive, options: PgnOptions = {}): string {
  const config = match.config;
  const tags: Array<[string, string]> = [
    ["Event", config.title],
    ["Site", options.site?.trim() || "Cockpit Chess"],
    ["Date", pgnDate(match.createdAt)],
    ["Round", "-"],
    ["White", config.white.name],
    ["Black", config.black.name],
    ["Result", match.result],
    ["WhiteType", playerType(config.white)],
    ["BlackType", playerType(config.black)],
    ["TimeControl", timeControlTag(match)],
    ["Termination", pgnTermination(match.termination)],
  ];
  const start = new Chess(config.initialFen);
  if (start.fen() !== new Chess(DEFAULT_POSITION).fen())
    tags.push(["SetUp", "1"], ["FEN", start.fen()]);
  tags.push(...rulesTags(config.rules));
  const tone = remarkTone(config.rules);
  const tokens: string[] = [];
  let pending: AttemptEvent[] = [];
  /** A Black move needs its number again after a comment (standard 8.2.2.2). */
  let needNumber = true;
  let moveNumber = start.moveNumber();
  const comment = (text: string) => {
    const clean = pgnCommentText(text);
    if (!clean) return;
    // Adjacent comments merge into one: some parsers (chess.js 1.4) reject two in a row.
    const last = tokens.at(-1);
    if (last?.startsWith("{")) tokens[tokens.length - 1] = `${last.slice(0, -1)} · ${clean}}`;
    else tokens.push(`{${clean}}`);
    needNumber = true;
  };
  let side = start.turn();
  for (const event of match.events) {
    if (event.type !== "attempt") continue;
    if (!event.accepted) {
      pending.push(event);
      continue;
    }
    if (pending.length) comment(rejectedText(pending, tone !== "off"));
    pending = [];
    if (side === "w") tokens.push(`${moveNumber}.`);
    else if (needNumber) tokens.push(`${moveNumber}...`);
    tokens.push(event.san ?? event.move);
    needNumber = false;
    if (tone !== "off" && event.comment) comment(event.comment);
    if (side === "b") moveNumber += 1;
    side = side === "w" ? "b" : "w";
  }
  // A forfeit's closing comment already lists its rejected moves; their remarks it lacks.
  const remarked = tone !== "off" && pending.some((attempt) => attempt.comment.trim());
  if (pending.length && (match.termination !== "illegal-forfeit" || remarked))
    comment(rejectedText(pending, tone !== "off"));
  if (match.termination !== "playing")
    comment((options.describeEnding ?? endingText)(matchEnding(match)));
  tokens.push(match.result);
  return `${tags.map(([name, value]) => `[${name} "${pgnTagValue(value, name)}"]`).join("\n")}\n\n${wrap(tokens)}\n`;
}
/**
 * Movetext lines stay under 80 characters (standard 8.2.1). Comments wrap between their
 * words, and a word longer than a line is split. A line that would start with `%` is
 * indented one space, so it can never read as a `%` escape line (standard 6).
 */
const LINE = 79;
function wrap(tokens: string[]) {
  const words = tokens.flatMap((token) =>
    token.startsWith("{")
      ? token.split(" ").flatMap((word) => word.match(/.{1,78}/gsu) ?? [])
      : [token],
  );
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > LINE) {
      lines.push(line);
      line = word.startsWith("%") ? ` ${word}` : word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
