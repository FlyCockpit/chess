-- Each statement returns zero rows. Matches created before user keys existed were all
-- admin matches on the operator key, so they must read as "operator".
SELECT id || ' has credentialSource ' || "credentialSource" AS violation
FROM "chess_match"
WHERE "credentialSource" IS DISTINCT FROM 'operator';
