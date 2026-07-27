-- Let a fund collect TYPED Member columns (address, phone, household counts, …)
-- on the public signup form, instead of only custom applicationData answers.
--
-- Additive and backfill-free: every existing OnboardingField keeps
-- builtinKey NULL and therefore keeps writing to applicationData exactly as
-- before. In particular a fund that already has a custom field keyed
-- `address` is untouched — that is the whole reason this is an explicit
-- column rather than inferring built-in-ness from the key name.

ALTER TABLE "OnboardingField" ADD COLUMN "builtinKey" TEXT;

-- No unique index needed: for a built-in field `key` is set to the same value
-- as `builtinKey`, so the existing OnboardingField_fundId_target_key_key
-- constraint already prevents adding the same attribute twice per form.
