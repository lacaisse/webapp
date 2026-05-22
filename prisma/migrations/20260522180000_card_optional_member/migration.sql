-- Cards become first-class fund objects: bind to a fund directly, optionally
-- to a member. Lets us import CitizenPay-only cards without forcing an admin
-- to pick a member up front.

-- 1. Add fundId, nullable for the backfill step.
ALTER TABLE "Card" ADD COLUMN "fundId" TEXT;

-- 2. Backfill fundId from the existing member relation. Every current Card
--    has a memberId (it was NOT NULL) so this populates every row.
UPDATE "Card"
SET "fundId" = "Member"."fundId"
FROM "Member"
WHERE "Card"."memberId" = "Member"."id";

-- 3. Enforce NOT NULL once the backfill is in place.
ALTER TABLE "Card" ALTER COLUMN "fundId" SET NOT NULL;

-- 4. Wire the FK with cascade so deleting a fund removes its cards (parity
--    with the previous member-cascade behaviour).
ALTER TABLE "Card"
  ADD CONSTRAINT "Card_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Card_fundId_idx" ON "Card"("fundId");

-- 5. Drop the NOT NULL on memberId and relax the FK to SET NULL — deleting
--    a member now leaves their cards as unattached rows rather than
--    cascading the card away. The fund-level cascade above is enough to
--    keep imports cleaned up.
ALTER TABLE "Card" ALTER COLUMN "memberId" DROP NOT NULL;

ALTER TABLE "Card" DROP CONSTRAINT "Card_memberId_fkey";
ALTER TABLE "Card"
  ADD CONSTRAINT "Card_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
