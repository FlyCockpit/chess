import { matchConfigSchema, type RemarkTone } from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import {
  type CONTEXT_MODES,
  type ENGINE_MODES,
  type IDENTITY_MODES,
  LIMITS,
  type MOVE_FORMATS,
  type ProtocolChoice,
  resolveProtocol,
  type TOKEN_ACCOUNTING,
} from "./create-match-form";
import {
  autoMoveLimitMs,
  clockFromTimeControl,
  DEFAULT_TIME_CONTROL,
  type TimeControlValue,
  timeControlErrors,
  timeControlSummary,
} from "./time-control";

/** The local lab's "Set up your opponent" form: values, defaults, sections and its config. */
export const LAB_MODES = ["play", "simulate"] as const;
export type LabSection = "rules" | "limits" | "connection";

export type LabValues = {
  mode: (typeof LAB_MODES)[number];
  model: string;
  time: TimeControlValue;
  remarks: RemarkTone;
  context: (typeof CONTEXT_MODES)[number];
  identity: (typeof IDENTITY_MODES)[number];
  moveFormat: (typeof MOVE_FORMATS)[number];
  engineEvaluation: (typeof ENGINE_MODES)[number];
  tokenAccounting: (typeof TOKEN_ACCOUNTING)[number];
  /** Text while editing; a whole number of tokens at submit. */
  tokenBudget: string;
  protocol: ProtocolChoice;
};

export const LAB_DEFAULTS: LabValues = {
  mode: "play",
  model: "openai/gpt-4.1-nano",
  time: DEFAULT_TIME_CONTROL,
  remarks: "off",
  context: "fresh",
  identity: "hidden",
  moveFormat: "strict",
  engineEvaluation: "off",
  tokenAccounting: "provider",
  tokenBudget: String(LIMITS.tokens.max),
  protocol: "auto",
};

/** Which closed section holds a field, so a failed submit can open it. */
export const LAB_FIELD_SECTION: Partial<Record<keyof LabValues, LabSection>> = {
  context: "rules",
  identity: "rules",
  moveFormat: "rules",
  engineEvaluation: "rules",
  tokenAccounting: "limits",
  tokenBudget: "limits",
  protocol: "connection",
};

/** The sections to open after a blocked submit: those holding a field that has errors. */
export function sectionsWithErrors(
  fieldMeta: Partial<Record<string, { errors?: readonly unknown[] } | undefined>>,
): LabSection[] {
  const sections = Object.entries(fieldMeta).flatMap(([name, meta]) => {
    const section = LAB_FIELD_SECTION[name as keyof LabValues];
    return section && meta?.errors?.length ? [section] : [];
  });
  return [...new Set(sections)];
}

export function tokenBudgetValid(value: string) {
  const tokens = Number(value);
  return (
    value.trim() !== "" &&
    Number.isInteger(tokens) &&
    tokens >= LIMITS.tokens.min &&
    tokens <= LIMITS.tokens.max
  );
}

/** The closed form's one-line summary: "You versus model · Untimed · Fresh context · No remarks". */
export function labSummary(value: LabValues, t: TFunction<"chess">) {
  const parts = [
    t(`local.${value.mode}`),
    timeControlSummary(t, value.time),
    t(`context.${value.context}`),
    t(`remarkTones.${value.remarks}`),
  ];
  if (value.engineEvaluation !== "off") parts.push(t(`engineModes.${value.engineEvaluation}`));
  return parts.join(" · ");
}

/**
 * The match the companion starts. The model plays Black against you, or both sides; its wire
 * protocol is the override, else derived from the id (as hosted Create match does).
 */
export function labMatchConfig(value: LabValues, t: TFunction<"chess">) {
  if (Object.keys(timeControlErrors(t, value.time)).length || !tokenBudgetValid(value.tokenBudget))
    return null;
  const clock = clockFromTimeControl(value.time);
  const id = value.model.trim();
  const model = { name: id, model: id, protocol: resolveProtocol(value.protocol, id, undefined) };
  const parsed = matchConfigSchema.safeParse({
    title: t(value.mode === "play" ? "local.playTitle" : "local.simulateTitle"),
    white:
      value.mode === "play" ? { name: t("lab.human"), model: "human", protocol: "human" } : model,
    black: model,
    rules: {
      context: value.context,
      opponentIdentity: value.identity,
      clock,
      turnTimeoutMs: autoMoveLimitMs(clock),
      tokenBudget: Number(value.tokenBudget),
      tokenAccounting: value.tokenAccounting,
      engineEvaluation: value.engineEvaluation,
      remarks: value.remarks,
      moveFormat: value.moveFormat,
      costBudgetMicros: 100000,
    },
  });
  return parsed.success ? parsed.data : null;
}
