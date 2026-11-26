import {
  type MatchConfig,
  MODEL_PROTOCOLS,
  type ModelProtocol,
  matchConfigSchema,
  protocolForModel,
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

/** The hosted operator limits `chess.create` enforces, mirrored for inline errors. */
export const LIMITS = {
  title: 140,
  model: 160,
  name: 80,
  budgetUsd: { min: 0.01, max: 1 },
  tokens: { min: 256, max: 1_000_000 },
} as const;

export type CreateMatchValues = {
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
  /** Numeric inputs stay strings in the form; the schema parses them. */
  tokenBudget: string;
  budget: string;
  /** Per-move safety limit in seconds; "" = automatic (1 min, never above a clock). */
  moveLimit: string;
};

/** The same defaults the form always started from; only the protocol is now derived. */
export const DEFAULT_VALUES: CreateMatchValues = {
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
  tokenBudget: "1000000",
  budget: "0.10",
  moveLimit: "",
};

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
  tokenAccounting: "limits",
  tokenBudget: "limits",
  budget: "limits",
  moveLimit: "limits",
};

/**
 * The rule the old native inputs enforced: a number in [min, max] on the
 * input's step (whole numbers, or whole cents for dollars). Anything a number
 * input can hold parses, `1e3` included.
 */
function inRange(raw: string, { min, max }: { min: number; max: number }, step: 1 | 0.01) {
  if (!raw.trim()) return false;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return false;
  const steps = value / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}
function numberInRange(
  t: TFunction<"chess">,
  limits: { min: number; max: number },
  step: 1 | 0.01,
) {
  return z.string().refine((raw) => inRange(raw, limits, step), {
    message:
      step === 1 ? t("create.errors.integerRange", limits) : t("create.errors.centRange", limits),
  });
}

/** Per-field validation with the hosted limits; `toMatchConfig` runs the shared schema after it. */
export function createMatchSchema(t: TFunction<"chess">) {
  const model = z
    .string()
    .trim()
    .min(1, { message: t("create.errors.model") })
    .max(LIMITS.model, { message: t("create.errors.modelLength", { max: LIMITS.model }) });
  return z
    .object({
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
      tokenBudget: numberInRange(t, LIMITS.tokens, 1),
      budget: numberInRange(t, LIMITS.budgetUsd, 0.01),
      moveLimit: z.string(),
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
      costBudgetMicros: Math.round(Number(value.budget) * 1_000_000),
      tokenBudget: Number(value.tokenBudget),
      tokenAccounting: value.tokenAccounting,
      engineEvaluation: value.engineEvaluation,
      remarks: value.remarks,
      moveFormat: value.moveFormat,
      clock,
      turnTimeoutMs,
    },
  });
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/** "Untimed · Fresh context · Legal-move tool · Strict format · $0.10 budget", plus non-defaults. */
export function summaryParts(
  value: CreateMatchValues,
  t: TFunction<"chess">,
  currency: Intl.NumberFormat,
) {
  const budget = Number(value.budget);
  const parts = [
    timeControlSummary(t, value.time),
    t(`context.${value.context}`),
    t(`tools.${value.tools}`),
    t("create.summary.format", { format: t(`moveFormats.${value.moveFormat}`) }),
    t("create.summary.budget", {
      budget: Number.isFinite(budget) ? currency.format(budget) : value.budget,
    }),
  ];
  if (value.engineEvaluation !== "off") parts.push(t(`engineModes.${value.engineEvaluation}`));
  if (value.remarks !== "off") parts.push(t(`remarkTones.${value.remarks}`));
  if (value.identity === "disclosed") parts.push(t("identity.disclosed"));
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
