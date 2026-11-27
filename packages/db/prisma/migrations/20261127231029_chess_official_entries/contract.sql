-- Retire the mutable prerelease flag. No historical rows are enrolled.
-- intentional: drop and recreate
ALTER TABLE "chess_match" DROP COLUMN "official";
