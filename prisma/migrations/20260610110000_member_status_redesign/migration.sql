-- Redesign MemberStatus to the operator-facing set used for allocation /
-- email gating (issue #17). Only ACTIVE members receive allocations + emails;
-- every other status suppresses both but carries distinct meaning.
--
--   INVITED, ONBOARDING -> NEW      (signed up / added, not active yet)
--   ACTIVE              -> ACTIVE
--   INACTIVE            -> INACTIVE
--   LEFT                -> STOPPED   (actively stopped / resigned)
--   (new)               -> PAUSED, REJECTED
--
-- Postgres can't drop enum values in place, so swap the type.

CREATE TYPE "MemberStatus_new" AS ENUM ('NEW', 'ACTIVE', 'INACTIVE', 'PAUSED', 'STOPPED', 'REJECTED');

ALTER TABLE "Member" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Member"
  ALTER COLUMN "status" TYPE "MemberStatus_new"
  USING (
    CASE "status"::text
      WHEN 'INVITED' THEN 'NEW'
      WHEN 'ONBOARDING' THEN 'NEW'
      WHEN 'LEFT' THEN 'STOPPED'
      ELSE "status"::text
    END::"MemberStatus_new"
  );

DROP TYPE "MemberStatus";
ALTER TYPE "MemberStatus_new" RENAME TO "MemberStatus";

ALTER TABLE "Member" ALTER COLUMN "status" SET DEFAULT 'NEW';
