-- Email templates become per-language: a fund can edit each supported locale
-- independently instead of one override applying to every recipient. Existing
-- single-locale overrides were applied to everyone; attribute each to its fund's
-- default locale so its current wording is preserved for that language (other
-- languages fall through to the built-in localized defaults).
ALTER TABLE "EmailTemplate" ADD COLUMN "locale" TEXT;

UPDATE "EmailTemplate" et
  SET "locale" = f."defaultLocale"
  FROM "Fund" f
  WHERE et."fundId" = f."id";

-- Safety net for any row whose fund lookup didn't resolve.
UPDATE "EmailTemplate" SET "locale" = 'fr' WHERE "locale" IS NULL;

ALTER TABLE "EmailTemplate" ALTER COLUMN "locale" SET NOT NULL;

DROP INDEX "EmailTemplate_fundId_type_key";

CREATE UNIQUE INDEX "EmailTemplate_fundId_type_locale_key"
  ON "EmailTemplate"("fundId", "type", "locale");
