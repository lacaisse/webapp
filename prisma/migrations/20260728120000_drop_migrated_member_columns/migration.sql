-- Drop the member columns whose data moved to `applicationData` in
-- 20260727190000_member_extras_to_application_data.
--
-- DESTRUCTIVE and deliberately deferred to its own release: the previous
-- migration copied every non-default value into the JSON store and left these
-- columns in place so the move could be verified against production and rolled
-- back if it hadn't been. It was (231 phones, 60 IBANs, 90/58 household counts,
-- zero mismatches), and the code that read them shipped in #134, so they now
-- hold nothing but a stale copy.
--
-- Do not run this before the release that stops reading these columns is live.
--
-- Dropping householdAdults/householdChildren also retires their NOT NULL
-- defaults of 1 and 0, which were the reason "never asked" and "answered with
-- the default" were indistinguishable. In `applicationData` an unanswered
-- question simply has no key, so unanswered finally has one representation.

ALTER TABLE "Member" DROP COLUMN "phone";
ALTER TABLE "Member" DROP COLUMN "iban";
ALTER TABLE "Member" DROP COLUMN "householdAdults";
ALTER TABLE "Member" DROP COLUMN "householdChildren";
