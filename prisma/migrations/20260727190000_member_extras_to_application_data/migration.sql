-- Move the member attributes that are NOT base identity out of typed columns
-- and into the per-fund custom-question store.
--
-- Base/system columns stay: firstName, lastName, email (identity), the postal
-- address trio (read by formatMemberAddress for the {address} email
-- placeholder), tierId and contributionAmount (allocation system), locale
-- (captured from the request, picks the email language) and notes (staff
-- commentary, never asked of an applicant).
--
-- Moving: phone, iban, householdAdults, householdChildren. None of them has a
-- code consumer today — the EPC QR uses the FUND's banking IBAN and bank-sync
-- matches through LinkedBankAccount, so Member.iban was pure storage.
--
-- The columns are deliberately NOT dropped here. Keeping them for one release
-- makes this migration verifiable and revertible; a follow-up drops them once
-- the data is confirmed in production.

-- 1. Field definitions -------------------------------------------------------
-- A definition is created only for funds that actually hold data in that
-- column, so a fund that never collected IBANs doesn't suddenly start asking
-- for one. They are created ACTIVE; archiving the ones a given fund would
-- rather not ask going forward is an admin decision, not a migration's.
--
-- `key` matches the old column name (including camelCase, which the admin
-- form's own key rule wouldn't accept) on purpose: a migrated answer stays
-- traceable to the column it came from, and the CSV import keeps its mapping.
--
-- id and updatedAt have no database default (Prisma supplies cuid()/@updatedAt
-- at runtime), so both are set explicitly here.

INSERT INTO "OnboardingField" ("id", "fundId", "target", "key", "builtinKey", "type", "label", "required", "position", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, f."id", 'MEMBER', 'phone', NULL, 'PHONE',
  CASE f."defaultLocale" WHEN 'fr' THEN 'Téléphone' WHEN 'nl' THEN 'Telefoon' WHEN 'es' THEN 'Teléfono' ELSE 'Phone number' END,
  false,
  COALESCE((SELECT MAX(o2."position") FROM "OnboardingField" o2 WHERE o2."fundId" = f."id" AND o2."target" = 'MEMBER'), -1) + 1,
  now(), now()
FROM "Fund" f
WHERE EXISTS (SELECT 1 FROM "Member" m WHERE m."fundId" = f."id" AND m."phone" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "OnboardingField" o WHERE o."fundId" = f."id" AND o."target" = 'MEMBER' AND o."key" = 'phone');

INSERT INTO "OnboardingField" ("id", "fundId", "target", "key", "builtinKey", "type", "label", "required", "position", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, f."id", 'MEMBER', 'iban', NULL, 'TEXT',
  'IBAN',
  false,
  COALESCE((SELECT MAX(o2."position") FROM "OnboardingField" o2 WHERE o2."fundId" = f."id" AND o2."target" = 'MEMBER'), -1) + 1,
  now(), now()
FROM "Fund" f
WHERE EXISTS (SELECT 1 FROM "Member" m WHERE m."fundId" = f."id" AND m."iban" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "OnboardingField" o WHERE o."fundId" = f."id" AND o."target" = 'MEMBER' AND o."key" = 'iban');

INSERT INTO "OnboardingField" ("id", "fundId", "target", "key", "builtinKey", "type", "label", "required", "position", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, f."id", 'MEMBER', 'householdAdults', NULL, 'NUMBER',
  CASE f."defaultLocale" WHEN 'fr' THEN 'Adultes dans le foyer' WHEN 'nl' THEN 'Volwassenen in het huishouden' WHEN 'es' THEN 'Adultos en el hogar' ELSE 'Adults in the household' END,
  false,
  COALESCE((SELECT MAX(o2."position") FROM "OnboardingField" o2 WHERE o2."fundId" = f."id" AND o2."target" = 'MEMBER'), -1) + 1,
  now(), now()
FROM "Fund" f
WHERE EXISTS (SELECT 1 FROM "Member" m WHERE m."fundId" = f."id" AND m."householdAdults" <> 1)
  AND NOT EXISTS (SELECT 1 FROM "OnboardingField" o WHERE o."fundId" = f."id" AND o."target" = 'MEMBER' AND o."key" = 'householdAdults');

INSERT INTO "OnboardingField" ("id", "fundId", "target", "key", "builtinKey", "type", "label", "required", "position", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, f."id", 'MEMBER', 'householdChildren', NULL, 'NUMBER',
  CASE f."defaultLocale" WHEN 'fr' THEN 'Enfants dans le foyer' WHEN 'nl' THEN 'Kinderen in het huishouden' WHEN 'es' THEN 'Niños en el hogar' ELSE 'Children in the household' END,
  false,
  COALESCE((SELECT MAX(o2."position") FROM "OnboardingField" o2 WHERE o2."fundId" = f."id" AND o2."target" = 'MEMBER'), -1) + 1,
  now(), now()
FROM "Fund" f
WHERE EXISTS (SELECT 1 FROM "Member" m WHERE m."fundId" = f."id" AND m."householdChildren" <> 0)
  AND NOT EXISTS (SELECT 1 FROM "OnboardingField" o WHERE o."fundId" = f."id" AND o."target" = 'MEMBER' AND o."key" = 'householdChildren');

-- 2. The answers themselves --------------------------------------------------
-- Values are written as JSON STRINGS, including the counts: that is what the
-- signup form produces for a NUMBER field (its inputs are strings), so the
-- migrated rows are indistinguishable from ones captured through the form.
--
-- The household counts are non-nullable with defaults 1 and 0, so "never
-- answered" and "answered with the default" are indistinguishable in the
-- column. Only values that differ from the default are migrated — asserting
-- "1 adult" for every member who was never asked would be fabricating data.
--
-- `||` merges into any existing answers rather than replacing them, and
-- jsonb_strip_nulls drops the keys this member has no value for.

UPDATE "Member" m
SET "applicationData" = COALESCE(m."applicationData", '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'phone', m."phone",
      'iban', m."iban",
      'householdAdults', CASE WHEN m."householdAdults" <> 1 THEN m."householdAdults"::text ELSE NULL END,
      'householdChildren', CASE WHEN m."householdChildren" <> 0 THEN m."householdChildren"::text ELSE NULL END
    ))
WHERE m."phone" IS NOT NULL
   OR m."iban" IS NOT NULL
   OR m."householdAdults" <> 1
   OR m."householdChildren" <> 0;
