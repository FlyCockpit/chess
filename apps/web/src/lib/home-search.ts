import { z } from "zod";

/**
 * Search-param contract for the public home page (`/$lang/?tab=&game=`).
 *
 * Lives here rather than inline in the route so it can be unit tested against
 * the router's real search parser (route files must not export anything).
 *
 * Every field falls back to `undefined` instead of failing: these links are
 * shared and hand-edited, and a stale or mistyped `?tab=` must land on the
 * arena, not the route error screen.
 */
const resultsFilterSchema = z.object({
  promptVersion: z
    .union([z.string(), z.number().int().positive()])
    .transform((value) => String(value))
    .pipe(z.string().min(1).max(32))
    .optional()
    .catch(undefined),
  rulesKey: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional()
    .catch(undefined),
  initialPositionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .catch(undefined),
  billingCohort: z.enum(["operator", "owner-openrouter"]).optional().catch(undefined),
  opponentType: z.enum(["model-v-model", "model-v-random"]).optional().catch(undefined),
});
export type ResultsFilter = z.infer<typeof resultsFilterSchema>;
export const homeSearchSchema = resultsFilterSchema.extend({
  tab: z.enum(["arena", "leaderboard", "lab", "methodology", "studio"]).optional().catch(undefined),
  game: z.string().max(180).optional().catch(undefined),
  category: z.enum(["all", "vs-humans"]).optional().catch(undefined),
});
