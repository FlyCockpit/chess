import {
  type IllegalPolicy,
  illegalPolicies,
  type MatchConfig,
  MODEL_PROTOCOLS,
  type ModelProtocol,
  matchConfigSchema,
  protocolForModel,
  REPLY_CAP_MAX,
  REPLY_CAP_MIN,
  type RemarkTone,
  type Rules,
  remarkTones,
} from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import { z } from "zod";
import {
  clockFromTimeControl,
  DEFAULT_TIME_CONTROL,
  MOVE_LIMIT_SECONDS,
  moveLimitMs,
  type TimeControlValue,
  timeControlErrors,
  timeControlSummary,
} from "./time-control";

/**
 * The create-match form's model: defaults, validation, the one-line summary and
 * the conversion to `matchConfigSchema`. Kept apart from the dialog so the
 * rules are unit-tested without rendering it.
 */

/** One catalog row as `chess.models` returns it (packages/api/src/lib/chess-models.ts). */
export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  /** The model's own maximum output per reply, when the catalog lists one. */
  maxOutputTokens: number | null;
  promptPerMillion: number;
  completionPerMillion: number;
  tools: boolean;
  protocol: ModelProtocol;
};
export type ProtocolChoice = "auto" | ModelProtocol;
export const PROTOCOL_CHOICES = ["auto", ...MODEL_PROTOCOLS] as const;
export const CONTEXT_MODES = ["fresh", "persistent"] as const;
export const IDENTITY_MODES = ["hidden", "disclosed"] as const;
export const LEGAL_MOVE_MODES = ["hidden", "tool", "provided"] as const;
export const MOVE_FORMATS = ["strict", "lenient"] as const;
export const ENGINE_MODES = ["off", "tool", "after-move", "both"] as const;
export const TOKEN_ACCOUNTING = ["provider", "cl100k_base"] as const;
export const REMARK_TONES = remarkTones;
export const ILLEGAL_POLICIES = illegalPolicies;

/** Field limits the shared schema enforces, mirrored for inline errors. */
export const LIMITS = {
  title: 140,
  model: 160,
  name: 80,
  budgetUsd: { min: 0.01 },
  /** `max` bounds the local lab's own token field; hosted maxima come from the server. */
  tokens: { min: 256, max: 1_000_000 },
  attempts: { min: 1, max: 10 },
  replyCap: { min: REPLY_CAP_MIN, max: REPLY_CAP_MAX },
} as const;

/** The server's per-side operator limits (`chess.info`, from `CHESS_MAX_*`). */
export type HostedLimits = { maxCostMicros: number; maxTokens: number };
/** Used only until `chess.info` answers (the create button stays disabled until then). */
export const FALLBACK_LIMITS: HostedLimits = { maxCostMicros: 25_000_000, maxTokens: 10_000_000 };
/** The hosted per-side budget maximum in US dollars, never below the field's minimum. */
export function maxBudgetUsd(limits: HostedLimits) {
  return Math.max(LIMITS.budgetUsd.min, Math.floor(limits.maxCostMicros / 10_000) / 100);
}
/** Who pays a hosted match's players: the server's key (admins) or the user's own. */
export type Billing = "operator" | "openrouter";
/**
 * The limits a match billed to the user's own OpenRouter key may use: the operator's
 * per-side caps, and no more than half the key's remaining limit per side (both
 * players bill the same key). `remainingMicros` null = the key has no limit.
 * Advisory: OpenRouter's own limit stays the hard cap.
 */
export function billedLimits(limits: HostedLimits, remainingMicros: number | null): HostedLimits {
  if (remainingMicros === null) return limits;
  const perSide = Math.max(0, Math.floor(remainingMicros / 2));
  return { ...limits, maxCostMicros: Math.min(limits.maxCostMicros, perSide) };
}
/** Whether the key has too little left for even the smallest budget on both sides. */
export function keyExhausted(remainingMicros: number | null) {
  return remainingMicros !== null && remainingMicros < 2 * LIMITS.budgetUsd.min * 1_000_000;
}

/** `chess.create` refusals the form explains (the server's `data.reason`). */
export const CREATE_REFUSALS = [
  "hosted-disabled",
  "user-matches-disabled",
  "operator-billing-admin-only",
  "operator-key-missing",
  "openrouter-unavailable",
  "not-connected",
  "reconnect",
  "active-match",
  "daily-limit",
  "queue-full",
] as const;
export type CreateRefusal = (typeof CREATE_REFUSALS)[number];
/** The refusal a failed create carries, when it is one the form explains. */
export function createRefusal(error: unknown): CreateRefusal | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  const reason =
    data && typeof data === "object" && "reason" in data
      ? (data as { reason?: unknown }).reason
      : undefined;
  return CREATE_REFUSALS.find((value) => value === reason) ?? null;
}

/** A 1-2-5 series up to `max`, which always ends it: the slider's log-spaced stops. */
export function budgetStops(min: number, max: number) {
  const stops: number[] = [];
  for (let decade = 1e-2; decade <= max; decade *= 10)
    for (const digit of [1, 2, 5]) {
      const stop = Number((digit * decade).toPrecision(3));
      if (stop >= min && stop < max) stops.push(stop);
    }
  return [...stops, max];
}

export type CreateMatchValues = {
  official: boolean;
  title: string;
  white: string;
  black: string;
  whiteProtocol: ProtocolChoice;
  blackProtocol: ProtocolChoice;
  identity: Rules["opponentIdentity"];
  context: Rules["context"];
  tools: Rules["legalMoves"];
  moveFormat: Rules["moveFormat"];
  engineEvaluation: Rules["engineEvaluation"];
  remarks: RemarkTone;
  time: TimeControlValue;
  tokenAccounting: Rules["tokenAccounting"];
  /** Per side; the slider and typed value commit numbers within the server's limits. */
  tokenBudget: number;
  /** Per side, in US dollars. */
  budget: number;
  illegalPolicy: IllegalPolicy;
  /** Rejected attempts on one turn that forfeit (only under "forfeit"). */
  maxAttempts: number;
  /** Per-move safety limit in seconds; "" = automatic (1 min, never above a clock). */
  moveLimit: string;
  /** Optional reply cap in tokens, for experiments; "" = none (the model's own maximum). */
  replyCap: string;
};

/** The same defaults the form always started from; only the protocol is now derived. */
export const DEFAULT_VALUES: CreateMatchValues = {
  official: false,
  title: "",
  white: "openai/gpt-4.1-nano",
  black: "openai/gpt-4.1-mini",
  whiteProtocol: "auto",
  blackProtocol: "auto",
  identity: "hidden",
  context: "fresh",
  tools: "tool",
  moveFormat: "strict",
  engineEvaluation: "off",
  remarks: "off",
  time: DEFAULT_TIME_CONTROL,
  tokenAccounting: "provider",
  tokenBudget: 1_000_000,
  budget: 1,
  illegalPolicy: "forfeit",
  maxAttempts: 3,
  moveLimit: "",
  replyCap: "",
};

/** The defaults within the server's limits (a server capped below them starts at its cap). */
export function defaultValuesFor(limits: HostedLimits): CreateMatchValues {
  return {
    ...DEFAULT_VALUES,
    budget: Math.min(DEFAULT_VALUES.budget, maxBudgetUsd(limits)),
    tokenBudget: Math.min(DEFAULT_VALUES.tokenBudget, limits.maxTokens),
  };
}

export type SectionId = "players" | "rules" | "limits";
/** Which collapsed section owns a field, so a failed submit can open it. */
export const FIELD_SECTION: Partial<Record<keyof CreateMatchValues, SectionId>> = {
  whiteProtocol: "players",
  blackProtocol: "players",
  identity: "players",
  context: "rules",
  tools: "rules",
  moveFormat: "rules",
  engineEvaluation: "rules",
  illegalPolicy: "rules",
  maxAttempts: "rules",
  replyCap: "rules",
  tokenAccounting: "limits",
  tokenBudget: "limits",
  budget: "limits",
  moveLimit: "limits",
};

/** A number in [min, max] on the step (whole numbers, or whole cents for dollars). */
function inRange(value: number, { min, max }: { min: number; max: number }, step: 1 | 0.01) {
  if (!Number.isFinite(value) || value < min || value > max) return false;
  const steps = value / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}
/**
 * The range check behind the sliders (which already keep values in range): a value
 * over the server's limit names that limit, anything else the plain range.
 */
function numberInRange(
  t: TFunction<"chess">,
  limits: { min: number; max: number },
  step: 1 | 0.01,
  overLimit?: string,
) {
  return z.number().superRefine((value, context) => {
    if (inRange(value, limits, step)) return;
    context.addIssue({
      code: "custom",
      message:
        overLimit && Number.isFinite(value) && value > limits.max
          ? overLimit
          : step === 1
            ? t("create.errors.integerRange", limits)
            : t("create.errors.centRange", limits),
    });
  });
}

/** Per-field validation with the server's limits; `toMatchConfig` runs the shared schema after it. */
export function createMatchSchema(t: TFunction<"chess">, limits: HostedLimits = FALLBACK_LIMITS) {
  const budgetMax = maxBudgetUsd(limits);
  const model = z
    .string()
    .trim()
    .min(1, { message: t("create.errors.model") })
    .max(LIMITS.model, { message: t("create.errors.modelLength", { max: LIMITS.model }) });
  return z
    .object({
      official: z.boolean(),
      title: z.string().max(LIMITS.title, {
        message: t("create.errors.title", { max: LIMITS.title }),
      }),
      white: model,
      black: model,
      whiteProtocol: z.enum(PROTOCOL_CHOICES),
      blackProtocol: z.enum(PROTOCOL_CHOICES),
      identity: z.enum(IDENTITY_MODES),
      context: z.enum(CONTEXT_MODES),
      tools: z.enum(LEGAL_MOVE_MODES),
      moveFormat: z.enum(MOVE_FORMATS),
      engineEvaluation: z.enum(ENGINE_MODES),
      remarks: z.enum(REMARK_TONES),
      time: z.custom<TimeControlValue>().superRefine((value, context) => {
        for (const [side, message] of Object.entries(timeControlErrors(t, value)))
          context.addIssue({ code: "custom", message, path: [side] });
      }),
      tokenAccounting: z.enum(TOKEN_ACCOUNTING),
      tokenBudget: numberInRange(
        t,
        { min: LIMITS.tokens.min, max: limits.maxTokens },
        1,
        t("create.errors.overTokenLimit", { max: limits.maxTokens }),
      ),
      budget: numberInRange(
        t,
        { min: LIMITS.budgetUsd.min, max: budgetMax },
        0.01,
        t("create.errors.overBudgetLimit", { max: budgetMax }),
      ),
      illegalPolicy: z.enum(ILLEGAL_POLICIES),
      maxAttempts: numberInRange(t, LIMITS.attempts, 1),
      moveLimit: z.string(),
      replyCap: z.string().superRefine((value, context) => {
        if (replyCapTokens(value) === undefined)
          context.addIssue({
            code: "custom",
            message: t("create.errors.integerRange", LIMITS.replyCap),
          });
      }),
    })
    .superRefine((value, context) => {
      if (Object.keys(timeControlErrors(t, value.time)).length) return;
      if (moveLimitMs(value.moveLimit, clockFromTimeControl(value.time)) === null)
        context.addIssue({
          code: "custom",
          path: ["moveLimit"],
          message: t("time.errors.moveLimit", MOVE_LIMIT_SECONDS),
        });
    });
}

/**
 * The reply cap a field value sets: null when blank (no cap), the whole number of
 * tokens when in range, undefined when it is not a valid cap.
 */
export function replyCapTokens(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return inRange(value, LIMITS.replyCap, 1) ? value : undefined;
}

export function findModel(catalog: readonly CatalogModel[] | undefined, id: string) {
  const trimmed = id.trim();
  return catalog?.find((model) => model.id === trimmed);
}

/** The protocol a side will use: the override, else the catalog's, else the id's derivation. */
export function resolveProtocol(
  choice: ProtocolChoice,
  id: string,
  catalog: readonly CatalogModel[] | undefined,
): ModelProtocol {
  if (choice !== "auto") return choice;
  return findModel(catalog, id)?.protocol ?? protocolForModel(id);
}

/** Only hosted model/model and model/random pairings can commit official starts. */
export function officialEligible(config: Pick<MatchConfig, "white" | "black">) {
  const protocols = [config.white.protocol, config.black.protocol];
  return (
    protocols.every(
      (protocol) => protocol === "random" || MODEL_PROTOCOLS.some((model) => model === protocol),
    ) && protocols.some((protocol) => protocol !== "random")
  );
}

/** The display name a player carries: the catalog's name, else the id itself. */
function playerName(id: string, catalog: readonly CatalogModel[] | undefined) {
  const trimmed = id.trim();
  return (findModel(catalog, trimmed)?.name ?? trimmed).slice(0, LIMITS.name);
}

/** The title a blank title field becomes. */
export function autoTitle(
  value: Pick<CreateMatchValues, "white" | "black">,
  catalog: readonly CatalogModel[] | undefined,
  t: TFunction<"chess">,
) {
  return t("create.autoTitle", {
    white: playerName(value.white, catalog),
    black: playerName(value.black, catalog),
  }).slice(0, LIMITS.title);
}

export function toMatchConfig(
  value: CreateMatchValues,
  catalog: readonly CatalogModel[] | undefined,
  t: TFunction<"chess">,
): { success: true; data: MatchConfig } | { success: false } {
  const whiteName = playerName(value.white, catalog);
  const blackName = playerName(value.black, catalog);
  const title = value.title.trim() || autoTitle(value, catalog, t);
  if (Object.keys(timeControlErrors(t, value.time)).length) return { success: false };
  const clock = clockFromTimeControl(value.time);
  const turnTimeoutMs = moveLimitMs(value.moveLimit, clock);
  if (turnTimeoutMs === null) return { success: false };
  const replyCap = replyCapTokens(value.replyCap);
  if (replyCap === undefined) return { success: false };
  const parsed = matchConfigSchema.safeParse({
    title,
    white: {
      name: whiteName,
      model: value.white.trim(),
      protocol: resolveProtocol(value.whiteProtocol, value.white, catalog),
    },
    black: {
      name: blackName,
      model: value.black.trim(),
      protocol: resolveProtocol(value.blackProtocol, value.black, catalog),
    },
    rules: {
      context: value.context,
      opponentIdentity: value.identity,
      legalMoves: value.tools,
      costBudgetMicros: Math.round(value.budget * 1_000_000),
      tokenBudget: value.tokenBudget,
      // Under "retry" the attempt count is unused; the default keeps the rules key.
      ...(value.illegalPolicy === "retry"
        ? { illegalPolicy: "retry" as const }
        : { maxAttempts: value.maxAttempts }),
      tokenAccounting: value.tokenAccounting,
      engineEvaluation: value.engineEvaluation,
      remarks: value.remarks,
      moveFormat: value.moveFormat,
      clock,
      turnTimeoutMs,
      // No cap is recorded by omission: each reply may use the model's own maximum.
      ...(replyCap === null ? {} : { maxOutputTokens: replyCap }),
    },
  });
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/** "Untimed · Fresh context · Legal-move tool · Strict format · $1.00 budget", plus non-defaults. */
export function summaryParts(
  value: CreateMatchValues,
  t: TFunction<"chess">,
  currency: Intl.NumberFormat,
) {
  const budget = value.budget;
  const replyCap = replyCapTokens(value.replyCap);
  const parts = [
    timeControlSummary(t, value.time),
    t(`context.${value.context}`),
    t(`tools.${value.tools}`),
    t("create.summary.format", { format: t(`moveFormats.${value.moveFormat}`) }),
    t("create.summary.budget", {
      budget: currency.format(budget),
    }),
  ];
  // An invalid cap is the field's error to explain, not "No reply cap".
  if (replyCap === null) parts.push(t("create.summary.noReplyCap"));
  else if (replyCap !== undefined) parts.push(t("create.summary.replyCap", { count: replyCap }));
  if (value.engineEvaluation !== "off") parts.push(t(`engineModes.${value.engineEvaluation}`));
  if (value.remarks !== "off") parts.push(t(`remarkTones.${value.remarks}`));
  if (value.identity === "disclosed") parts.push(t("identity.disclosed"));
  if (value.illegalPolicy === "retry") parts.push(t("create.summary.retry"));
  else if (value.maxAttempts !== DEFAULT_VALUES.maxAttempts)
    parts.push(t("create.summary.forfeitAfter", { count: value.maxAttempts }));
  return parts;
}

/** Case-insensitive search over name, id and provider; every word must match. */
export function searchModels(catalog: readonly CatalogModel[], query: string, limit = 60) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? catalog.filter((model) => {
        const haystack = `${model.name} ${model.id} ${model.provider}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
    : catalog;
  return hits.slice(0, limit);
}
