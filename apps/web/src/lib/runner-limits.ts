export type OperatingValues = { matchMicros: number; dayMicros: number; concurrency: number };

/** Parse dollars without floating-point rounding or accepting exponent syntax. */
export function runnerUsdMicros(value: string): number | undefined {
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(value)) return undefined;
  const [whole = "", fraction = ""] = value.split(".");
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

export function runnerLimitValues(value: {
  match: string;
  day: string;
  concurrency: string;
}): OperatingValues | undefined {
  const matchMicros = runnerUsdMicros(value.match);
  const dayMicros = runnerUsdMicros(value.day);
  if (matchMicros === undefined || dayMicros === undefined || !/^\d{1,2}$/.test(value.concurrency))
    return undefined;
  const concurrency = Number(value.concurrency);
  if (concurrency < 1 || concurrency > 64) return undefined;
  return { matchMicros, dayMicros, concurrency };
}

export function raisesRunnerLimits(next: OperatingValues, current: OperatingValues): boolean {
  return (
    next.matchMicros > current.matchMicros ||
    next.dayMicros > current.dayMicros ||
    next.concurrency > current.concurrency
  );
}

export function exceedsRunnerCeiling(next: OperatingValues, hard: OperatingValues): boolean {
  return (
    next.matchMicros > hard.matchMicros ||
    next.dayMicros > hard.dayMicros ||
    next.concurrency > hard.concurrency
  );
}

/** Never render server messages, which might contain untrusted input. */
export function runnerLimitsError(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "CONFLICT") return "conflict";
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return "verification";
  if (code === "TOO_MANY_REQUESTS" || code === "SERVICE_UNAVAILABLE") return "unavailable";
  if (code === "NOT_FOUND") return "missing";
  return "failed";
}
