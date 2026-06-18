-- CARD_ASSIGNED: the "your card is on its way" notification sent to a member
-- once their card is assigned. Editable per-fund like ALLOCATION_CONFIRMATION.

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'CARD_ASSIGNED';

-- AlterTable: link an email to the card it concerns (powers the notify-status
-- badge on the card detail page).
ALTER TABLE "Email" ADD COLUMN "cardId" TEXT;
CREATE INDEX "Email_cardId_idx" ON "Email"("cardId");
ALTER TABLE "Email" ADD CONSTRAINT "Email_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: cache the CitizenPay treasury slug — the `network` segment of a
-- card's public tap URL (https://tap.citizenpay.xyz/card/<serial>?network=<slug>).
ALTER TABLE "Fund" ADD COLUMN "citizenPayTreasurySlug" TEXT;
