-- Members at the api, wallet claims and confirmations (plan "Bread
-- card-holder voting", PR W-2). CardEvent gains the holder-login kinds and a
-- short `detail` (the claim proof); Member.apiSyncedAt stamps the last
-- accepted PUT/DELETE /v2/treasury/members/{holder_ref}; CardHolderClaim is
-- the issuer's inbox of wallet claims the api left for the fund to confirm;
-- one new EmailType for the staff notification of a claimed card.

-- CreateEnum
CREATE TYPE "CardHolderClaimStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REFUSED', 'ATTACHED', 'SUPERSEDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CardEventKind" ADD VALUE 'HOLDER_ATTACHED';
ALTER TYPE "CardEventKind" ADD VALUE 'HOLDER_DETACHED';
ALTER TYPE "CardEventKind" ADD VALUE 'CLAIM_PENDING';
ALTER TYPE "CardEventKind" ADD VALUE 'CLAIM_CONFIRMED';
ALTER TYPE "CardEventKind" ADD VALUE 'CLAIM_REFUSED';

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'CARD_CLAIMED_FROM_WALLET';

-- AlterTable
ALTER TABLE "CardEvent" ADD COLUMN     "detail" TEXT;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "apiSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CardHolderClaim" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "cardId" TEXT,
    "holderRef" TEXT NOT NULL,
    "memberId" TEXT,
    "proof" TEXT,
    "status" "CardHolderClaimStatus" NOT NULL DEFAULT 'PENDING',
    "citizenPayEventId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,

    CONSTRAINT "CardHolderClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardHolderClaim_fundId_status_requestedAt_idx" ON "CardHolderClaim"("fundId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "CardHolderClaim_cardId_idx" ON "CardHolderClaim"("cardId");

-- CreateIndex
CREATE INDEX "CardHolderClaim_memberId_idx" ON "CardHolderClaim"("memberId");

-- CreateIndex
CREATE INDEX "CardHolderClaim_decidedById_idx" ON "CardHolderClaim"("decidedById");

-- AddForeignKey
ALTER TABLE "CardHolderClaim" ADD CONSTRAINT "CardHolderClaim_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardHolderClaim" ADD CONSTRAINT "CardHolderClaim_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardHolderClaim" ADD CONSTRAINT "CardHolderClaim_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardHolderClaim" ADD CONSTRAINT "CardHolderClaim_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open claim per card: the handler's find-then-create is not enough
-- under two concurrent deliveries; a P2002 here is read as "refresh".
CREATE UNIQUE INDEX "CardHolderClaim_fundId_serial_pending_key" ON "CardHolderClaim"("fundId", "serial") WHERE "status" = 'PENDING';

-- The api namespaces its event ids per kind ("pin:12", "holder:12",
-- "claim:12"); the receiver's idempotency key carries the type as well so it
-- never depends on that namespacing.
DROP INDEX "CitizenPayEvent_fundId_eventId_key";
CREATE UNIQUE INDEX "CitizenPayEvent_fundId_type_eventId_key" ON "CitizenPayEvent"("fundId", "type", "eventId");
