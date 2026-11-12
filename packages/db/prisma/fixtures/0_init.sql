-- Migration fixture data (CI check 4, `pnpm db:check-migrations`).
--
-- Written against the schema as it exists right after migration `0_init`.
-- The check loads it immediately after `0_init` is applied, then applies every
-- later migration on top, and asserts the rows survive. Because each fixture
-- file is pinned to the migration it was written against
-- (`fixtures/<migration_folder>.sql`), it never has to be rewritten when the
-- schema moves on — add rows for a table your new migration touches to the
-- fixture of the LATEST migration on the base branch (create the file if
-- needed). Assertions that must hold after all migrations go in
-- `fixtures/<migration_folder>.check.sql`: every statement there must return
-- zero rows.
--
-- Rows deliberately include NULLs in every nullable column, values that differ
-- only by case/whitespace (duplicate-prone under a future unique or citext
-- change), boundary numbers, and text that a future type change would have to
-- convert. Synthetic data only: no real people, no real secrets.

INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "role", "locale", "banned", "banReason", "banExpires", "twoFactorEnabled", "operationalAlerts") VALUES
  ('fx_user_admin', 'Fixture Admin', 'admin@example.test', true, NULL, 'admin', 'en-US', false, NULL, NULL, true, true),
  ('fx_user_plain', 'Fixture User', 'user@example.test', false, 'https://example.test/a.png', 'user', 'es-MX', NULL, NULL, NULL, NULL, false),
  ('fx_user_case', 'fixture user', 'User@Example.test', true, NULL, 'user', 'en-US', true, 'spam', '2030-01-01 00:00:00', false, true),
  ('fx_user_space', ' Fixture User ', 'user+tag@example.test', true, '', 'user', 'en-US', NULL, '', NULL, NULL, true),
  ('fx_user_unicode', 'Zoë Ångström 😀', 'zoe@example.test', true, NULL, 'user', 'en-US', NULL, NULL, NULL, NULL, true);

INSERT INTO "session" ("id", "expiresAt", "token", "ipAddress", "userAgent", "userId", "impersonatedBy", "activeOrganizationId", "origin") VALUES
  ('fx_session_1', '2030-01-01 00:00:00', 'fx-token-1', '127.0.0.1', 'fixture-agent', 'fx_user_admin', NULL, NULL, 'sign-in'),
  ('fx_session_2', '2000-01-01 00:00:00', 'fx-token-2', NULL, NULL, 'fx_user_plain', 'fx_user_admin', NULL, 'impersonation');

INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "issuer") VALUES
  ('fx_account_1', 'fx_user_admin', 'credential', 'fx_user_admin', NULL, NULL, NULL, NULL, NULL, NULL, 'fixture-not-a-real-hash', 'local:credential'),
  ('fx_account_2', '12345', 'github', 'fx_user_plain', 'fx-access', NULL, NULL, '2030-01-01 00:00:00', NULL, 'read:user', NULL, 'https://github.com'),
  ('fx_account_3', '12345', 'google', 'fx_user_case', NULL, NULL, NULL, NULL, NULL, '', NULL, 'https://accounts.google.com');

INSERT INTO "verification" ("id", "identifier", "value", "expiresAt") VALUES
  ('fx_verification_1', 'email-verification:user@example.test', 'fx-value', '2030-01-01 00:00:00'),
  ('fx_verification_2', 'email-verification:user@example.test', 'fx-value', '2000-01-01 00:00:00');

INSERT INTO "two_factor" ("id", "secret", "backupCodes", "verified", "failedVerificationCount", "lockedUntil", "userId") VALUES
  ('fx_two_factor_1', 'fx-secret', '[]', true, 0, NULL, 'fx_user_admin'),
  ('fx_two_factor_2', 'fx-secret', '["a","b"]', false, 2147483647, '2030-01-01 00:00:00', 'fx_user_case');

INSERT INTO "app_setting" ("key", "value") VALUES
  ('fx.flag', 'true'),
  ('fx.number', '42'),
  ('fx.empty', '');

INSERT INTO "device_code" ("id", "deviceCode", "userCode", "userId", "expiresAt", "status", "lastPolledAt", "pollingInterval", "clientId", "scope") VALUES
  ('fx_device_1', 'fx-device-code', 'FXCODE-1', NULL, '2030-01-01 00:00:00', 'pending', NULL, 5, 'mycli', NULL),
  ('fx_device_2', 'fx-device-code-2', 'fxcode-1', 'fx_user_admin', '2000-01-01 00:00:00', 'approved', '2000-01-01 00:00:00', NULL, NULL, '');

INSERT INTO "apikey" ("id", "configId", "name", "start", "prefix", "key", "referenceId", "refillInterval", "refillAmount", "lastRefillAt", "enabled", "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", "remaining", "lastRequest", "expiresAt", "permissions", "metadata") VALUES
  ('fx_apikey_1', 'default', 'Fixture key', 'fx_', 'fx', 'fx-hashed-key', 'fx_user_admin', NULL, NULL, NULL, true, true, 86400000, 1000, 0, NULL, NULL, NULL, NULL, NULL),
  ('fx_apikey_2', 'default', NULL, NULL, NULL, 'fx-hashed-key-2', 'fx_user_plain', 3600, 10, '2026-01-01 00:00:00', NULL, NULL, NULL, NULL, NULL, -1, NULL, '2000-01-01 00:00:00', '{"cli":["read"]}', '{}');

INSERT INTO "chess_match" ("id", "slug", "ownerId", "title", "whiteName", "blackName", "status", "published", "official", "source", "rulesKey", "contextMode", "identityMode", "runToken", "heartbeatAt", "archive", "result", "whiteModel", "whiteProtocol", "blackModel", "blackProtocol", "whiteIllegal", "blackIllegal", "whiteCostMicros", "blackCostMicros", "moveFormat") VALUES
  ('fx_match_draft', 'fixture-draft', 'fx_user_admin', '', 'White', 'black', 'draft', false, false, 'hosted', 'standard', 'full', 'named', NULL, NULL, '{"moves":[],"label":"Zoë 😀"}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fx_match_public', 'fixture-published', 'fx_user_plain', 'Fixture match', 'White', 'Black', 'complete', true, true, 'imported', 'standard', 'last', 'anonymous', 'fx-run', '2030-01-01 00:00:00', '{"moves":["e2e4"],"nested":{"text":"quotes and Unicode Å"}}', '1-0', '', 'openai', 'Fixture Model', 'anthropic', 0, 2147483647, 0, 9223372036854775807, 'strict');

-- Exact expiry boundary: equal timestamps survive predicates using strict <.
INSERT INTO "verification" ("id", "createdAt", "updatedAt", "identifier", "value", "expiresAt") VALUES
  ('fx_verification_boundary', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '', '', '2026-01-01 00:00:00');
