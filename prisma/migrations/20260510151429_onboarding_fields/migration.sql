-- CreateEnum
CREATE TYPE "OnboardingTarget" AS ENUM ('MEMBER', 'MERCHANT');

-- CreateEnum
CREATE TYPE "OnboardingFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'NUMBER', 'SELECT', 'MULTISELECT', 'CHECKBOX', 'DATE');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "applicationData" JSONB;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "country" TEXT;

-- CreateTable
CREATE TABLE "OnboardingField" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "target" "OnboardingTarget" NOT NULL,
    "key" TEXT NOT NULL,
    "type" "OnboardingFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingField_fundId_target_idx" ON "OnboardingField"("fundId", "target");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingField_fundId_target_key_key" ON "OnboardingField"("fundId", "target", "key");

-- AddForeignKey
ALTER TABLE "OnboardingField" ADD CONSTRAINT "OnboardingField_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
