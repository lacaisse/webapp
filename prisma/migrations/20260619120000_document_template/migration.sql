-- Per-fund override of a printable document's wording (the card onboarding
-- letter, rendered to PDF). One row per (fund, type); absence = use the
-- built-in default. Type-generic so more documents can be made editable
-- without DDL. The body is markdown-ish text with {{token}} placeholders.

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CARD_ONBOARDING_LETTER');

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_fundId_type_key" ON "DocumentTemplate"("fundId", "type");

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
