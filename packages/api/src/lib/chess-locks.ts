/**
 * The advisory lock (`pg_advisory_xact_lock(hashtext(...))`) that serializes every
 * hosted match create with an OpenRouter Disconnect: a create that bills the caller's
 * own key re-checks the connection under it, so it either commits before Disconnect's
 * transaction (which then cancels it while queued) or finds no key and is refused.
 */
export const CHESS_CREATE_LOCK = "cockpit-chess:chess-create";
