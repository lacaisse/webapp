-- Clear `builtinKey` values that no longer name a built-in.
--
-- The registry shrank to the postal address in the previous migration, so a
-- field still pointing at phone / iban / householdAdults / householdChildren
-- names a column its answers no longer go to. The code already degrades
-- safely — signupMemberAction checks `isMemberBuiltinKey` before routing and
-- otherwise treats the field as a custom question — but leaving the value
-- would mean the admin UI shows a "Member record" badge on a field that is,
-- in fact, ordinary custom data.
--
-- Kept as a separate migration rather than folded into the previous one so the
-- already-applied migration's checksum stays intact.

UPDATE "OnboardingField"
SET "builtinKey" = NULL
WHERE "builtinKey" IS NOT NULL
  AND "builtinKey" NOT IN ('address', 'postalCode', 'city');
