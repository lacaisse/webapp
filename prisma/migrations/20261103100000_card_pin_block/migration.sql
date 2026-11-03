-- PIN block after three wrong PIN entries (Citizen Pay api PR P, D12).
-- Card.blockedReason tells a PIN block (the api's, imported here, never
-- pushed over) from a fund block (local-authoritative). The fund registers a
-- treasury events webhook with the api (secret encrypted like the api key);
-- CitizenPayEvent keeps each delivery by event id (idempotency, last delivery
-- on the settings page); CardEvent is the local audit trail (imported blocks,
-- admin unblocks with the actor). Two new EmailTypes for the notifications.

-- CreateEnum
CREATE TYPE "CitizenPayEventOutcome" AS ENUM ('RECEIVED', 'APPLIED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "CardEventKind" AS ENUM ('PIN_BLOCKED', 'PIN_UNBLOCKED');

-- CreateEnum
CREATE TYPE "CardEventSource" AS ENUM ('WEBHOOK', 'SYNC', 'ADMIN');

-- CreateEnum
CREATE TYPE "CardBlockedReason" AS ENUM ('PIN', 'FUND');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailType" ADD VALUE 'CARD_PIN_BLOCKED';
ALTER TYPE "EmailType" ADD VALUE 'CARD_PIN_BLOCKED_HOLDER';

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "blockedReason" "CardBlockedReason";

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "citizenPayEventsSecretEnc" TEXT,
ADD COLUMN     "citizenPayEventsWebhookError" TEXT,
ADD COLUMN     "citizenPayEventsWebhookRegisteredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CitizenPayEvent" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "serial" TEXT,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "CitizenPayEventOutcome" NOT NULL DEFAULT 'RECEIVED',
    "detail" TEXT,

    CONSTRAINT "CitizenPayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardEvent" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "kind" "CardEventKind" NOT NULL,
    "source" "CardEventSource" NOT NULL,
    "actorUserId" UUID,
    "placeId" TEXT,
    "placeName" TEXT,
    "terminalId" TEXT,
    "citizenPayEventId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CitizenPayEvent_fundId_receivedAt_idx" ON "CitizenPayEvent"("fundId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CitizenPayEvent_fundId_eventId_key" ON "CitizenPayEvent"("fundId", "eventId");

-- CreateIndex
CREATE INDEX "CardEvent_cardId_at_idx" ON "CardEvent"("cardId", "at");

-- CreateIndex
CREATE INDEX "CardEvent_fundId_at_idx" ON "CardEvent"("fundId", "at");

-- CreateIndex
CREATE INDEX "CardEvent_actorUserId_idx" ON "CardEvent"("actorUserId");

-- AddForeignKey
ALTER TABLE "CitizenPayEvent" ADD CONSTRAINT "CitizenPayEvent_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEvent" ADD CONSTRAINT "CardEvent_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEvent" ADD CONSTRAINT "CardEvent_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEvent" ADD CONSTRAINT "CardEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
