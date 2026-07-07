-- The amount a member has committed to contribute — what we ASK them for in
-- payment-reminder emails (issue #82). NULL means "use the tier target": the
-- requested amount resolves to the tier's allocationAmount, so it auto-tracks
-- tier changes until an explicit value is set. Does NOT change the minted
-- allocation (always the tier's allocationAmount) nor the minimum-hit check
-- (always the tier's minContribution). See services/member/contribution.ts.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN "contributionAmount" DECIMAL(10,2);
