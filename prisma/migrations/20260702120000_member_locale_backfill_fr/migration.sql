-- Backfill: every member that existed before language capture predates the
-- `Member.locale` column and has no stored preference. Set them to French — the
-- platform's historical default and every current fund's default locale — so
-- their emails keep going out in French rather than resolving through the
-- fallback chain. New members get their language captured at signup, and the
-- CSV import can set it too; this only touches the rows still NULL.
UPDATE "Member" SET "locale" = 'fr' WHERE "locale" IS NULL;
