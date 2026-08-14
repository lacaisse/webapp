-- Email templates become a per-fund *library*: multiple named templates per
-- email type, with a separate assignment row deciding which one (if any) is
-- actually sent. A type with no assignment falls back to the built-in default,
-- which is never stored in the DB. This preserves every existing override:
-- each old single-template-per-(fund,type) row becomes a named template whose
-- per-locale content moves into EmailTemplateLocalization, and an assignment is
-- created pointing at it, so current funds keep sending exactly what they were.

-- 1. New tables -------------------------------------------------------------

CREATE TABLE "EmailTemplateLocalization" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "ctaLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailTemplateLocalization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailTemplateLocalization_templateId_locale_key"
    ON "EmailTemplateLocalization"("templateId", "locale");

CREATE TABLE "EmailTemplateAssignment" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailTemplateAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailTemplateAssignment_fundId_type_key"
    ON "EmailTemplateAssignment"("fundId", "type");
CREATE INDEX "EmailTemplateAssignment_fundId_idx"
    ON "EmailTemplateAssignment"("fundId");

-- 2. Add the template name column (temporary NULL — backfilled below) --------

ALTER TABLE "EmailTemplate" ADD COLUMN "name" TEXT;

-- 3. Data migration ---------------------------------------------------------
-- Collapse the per-(fund,type,locale) rows into one surviving template per
-- (fund,type), moving each locale's content into a localization row.

-- 3a. Move every existing row's content into a localization attached to its
--     group's survivor (the earliest row per fund+type). The survivor's own
--     locale is included, so no wording is lost.
INSERT INTO "EmailTemplateLocalization"
    ("id", "templateId", "locale", "subject", "bodyText", "bodyHtml", "ctaLabel", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    s.survivor_id,
    e."locale",
    e."subject",
    e."bodyText",
    e."bodyHtml",
    e."ctaLabel",
    e."createdAt",
    e."updatedAt"
FROM "EmailTemplate" e
JOIN (
    SELECT DISTINCT ON ("fundId", "type")
        "id" AS survivor_id, "fundId", "type"
    FROM "EmailTemplate"
    ORDER BY "fundId", "type", "createdAt", "id"
) s ON s."fundId" = e."fundId" AND s."type" = e."type";

-- 3b. Name the survivors (an admin can rename later).
UPDATE "EmailTemplate" SET "name" = 'Modèle personnalisé' WHERE "name" IS NULL;

-- 3c. Create an assignment per surviving template so the existing override
--     stays active for its fund+type.
INSERT INTO "EmailTemplateAssignment"
    ("id", "fundId", "type", "templateId", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    s."fundId",
    s."type",
    s.survivor_id,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("fundId", "type")
        "id" AS survivor_id, "fundId", "type"
    FROM "EmailTemplate"
    ORDER BY "fundId", "type", "createdAt", "id"
) s;

-- 3d. Delete the non-survivor rows (their content is now in localizations).
DELETE FROM "EmailTemplate" e
USING (
    SELECT DISTINCT ON ("fundId", "type")
        "id" AS survivor_id, "fundId", "type"
    FROM "EmailTemplate"
    ORDER BY "fundId", "type", "createdAt", "id"
) s
WHERE e."fundId" = s."fundId" AND e."type" = s."type" AND e."id" <> s.survivor_id;

-- 4. Finalize the EmailTemplate shape ---------------------------------------

ALTER TABLE "EmailTemplate" ALTER COLUMN "name" SET NOT NULL;

DROP INDEX "EmailTemplate_fundId_type_locale_key";

ALTER TABLE "EmailTemplate"
    DROP COLUMN "locale",
    DROP COLUMN "subject",
    DROP COLUMN "bodyText",
    DROP COLUMN "bodyHtml",
    DROP COLUMN "ctaLabel";

CREATE UNIQUE INDEX "EmailTemplate_fundId_type_name_key"
    ON "EmailTemplate"("fundId", "type", "name");
CREATE INDEX "EmailTemplate_fundId_idx" ON "EmailTemplate"("fundId");

-- 5. Foreign keys -----------------------------------------------------------

ALTER TABLE "EmailTemplateLocalization"
    ADD CONSTRAINT "EmailTemplateLocalization_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailTemplateAssignment"
    ADD CONSTRAINT "EmailTemplateAssignment_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailTemplateAssignment"
    ADD CONSTRAINT "EmailTemplateAssignment_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
