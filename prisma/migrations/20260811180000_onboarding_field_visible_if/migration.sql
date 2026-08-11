-- Adds optional conditional-visibility to OnboardingField: a field can now
-- be shown (and required) only when another custom field's answer satisfies
-- a comparison, e.g. `householdincome` only when `householdAdults` > 1.
-- See services/onboarding/visibility.ts for the { fieldKey, operator, value }
-- shape this column stores.

ALTER TABLE "OnboardingField" ADD COLUMN "visibleIf" JSONB;
