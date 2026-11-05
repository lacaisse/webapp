-- Invite codes open /join (services/fund-setup/join.ts): a holder of a
-- subscription waiver code creates their account and their fund in one go,
-- waived from the start; a signed-in holder does the same at /new?code=.
--
-- createdWithWaiverCodeId says which code a fund was CREATED with, written in
-- the same transaction as subscriptionWaivedAt / subscriptionWaiverCodeId and
-- never changed. Null for a fund that existed first and redeemed a code on
-- Settings → Subscription, or was waived from the shell — so /admin/waivers
-- can tell "created with this code" from "redeemed it". Nullable, no backfill.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "createdWithWaiverCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "Fund" ADD CONSTRAINT "Fund_createdWithWaiverCodeId_fkey" FOREIGN KEY ("createdWithWaiverCodeId") REFERENCES "SubscriptionWaiverCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
