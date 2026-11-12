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
export const homeSearchSchema = z.object({
  tab: z.enum(["arena", "leaderboard", "lab", "methodology", "studio"]).optional().catch(undefined),
  game: z.string().max(180).optional().catch(undefined),
});
