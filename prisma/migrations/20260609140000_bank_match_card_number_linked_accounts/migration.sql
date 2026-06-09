-- Bank-sync matching upgrade: per-fund card numbers (for Belgian structured
-- communication matching), how each deposit matched, the card a serial/OGM
-- reference resolved to, and a learned IBAN→member map for auto-matching.

-- CreateEnum
CREATE TYPE "BankMatchMethod" AS ENUM ('SERIAL', 'STRUCTURED_COMMUNICATION', 'IBAN', 'MANUAL');

-- CreateEnum
CREATE TYPE "LinkedBankAccountSource" AS ENUM ('ONBOARDING', 'MANUAL');

-- AlterTable: per-fund sequential card number (encoded in the OGM).
ALTER TABLE "Card" ADD COLUMN "number" INTEGER;

-- AlterTable: how an incoming deposit matched + the card it resolved to.
ALTER TABLE "BankTransaction" ADD COLUMN "matchMethod" "BankMatchMethod";
ALTER TABLE "BankTransaction" ADD COLUMN "cardId" TEXT;

-- CreateTable: learned IBAN → member mappings (one IBAN per member per fund).
CREATE TABLE "LinkedBankAccount" (
    "id"        TEXT NOT NULL,
    "fundId"    TEXT NOT NULL,
    "memberId"  TEXT NOT NULL,
    "iban"      TEXT NOT NULL,
    "source"    "LinkedBankAccountSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Card_fundId_number_key" ON "Card"("fundId", "number");

-- CreateIndex
CREATE INDEX "BankTransaction_cardId_idx" ON "BankTransaction"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedBankAccount_fundId_iban_key" ON "LinkedBankAccount"("fundId", "iban");

-- CreateIndex
CREATE INDEX "LinkedBankAccount_memberId_idx" ON "LinkedBankAccount"("memberId");

-- AddForeignKey
ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "Card"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedBankAccount"
  ADD CONSTRAINT "LinkedBankAccount_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedBankAccount"
  ADD CONSTRAINT "LinkedBankAccount_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: number existing cards 1…N per fund, ordered by serialNumber asc.
-- Admins can re-map afterwards via the CSV import / per-card edit.
WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (
        PARTITION BY "fundId" ORDER BY "serialNumber" ASC
    ) AS rn
    FROM "Card"
)
UPDATE "Card" c
SET "number" = n.rn
FROM numbered n
WHERE c."id" = n."id";

-- Seed learned IBANs from member onboarding data. Skip duplicates within a
-- fund (an ambiguous IBAN shared by two members is left to manual matching).
INSERT INTO "LinkedBankAccount" ("id", "fundId", "memberId", "iban", "source", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, m."fundId", m."id", m."iban", 'ONBOARDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."iban" IS NOT NULL AND m."iban" <> ''
ON CONFLICT ("fundId", "iban") DO NOTHING;
