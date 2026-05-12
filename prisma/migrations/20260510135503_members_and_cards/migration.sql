-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ONBOARDING', 'ACTIVE', 'INACTIVE', 'LEFT');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- AlterEnum
BEGIN;
CREATE TYPE "FundRole_new" AS ENUM ('OWNER', 'ADMIN', 'VIEWER');
ALTER TABLE "public"."FundMember" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "FundMember" ALTER COLUMN "role" TYPE "FundRole_new" USING ("role"::text::"FundRole_new");
ALTER TYPE "FundRole" RENAME TO "FundRole_old";
ALTER TYPE "FundRole_new" RENAME TO "FundRole";
DROP TYPE "public"."FundRole_old";
ALTER TABLE "FundMember" ALTER COLUMN "role" SET DEFAULT 'VIEWER';
COMMIT;

-- AlterTable
ALTER TABLE "FundMember" ALTER COLUMN "role" SET DEFAULT 'VIEWER';

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "userId" UUID,
    "address" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "householdAdults" INTEGER NOT NULL DEFAULT 1,
    "householdChildren" INTEGER NOT NULL DEFAULT 0,
    "iban" TEXT,
    "paymentReference" TEXT,
    "monthlyContribution" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tierId" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'INVITED',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "notes" TEXT,
    "primaryCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "holderName" TEXT,
    "status" "CardStatus" NOT NULL DEFAULT 'INACTIVE',
    "reportedLostAt" TIMESTAMP(3),
    "balance" DECIMAL(12,2),
    "lastTransactionAt" TIMESTAMP(3),
    "profileSyncedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_primaryCardId_key" ON "Member"("primaryCardId");

-- CreateIndex
CREATE INDEX "Member_fundId_status_idx" ON "Member"("fundId", "status");

-- CreateIndex
CREATE INDEX "Member_userId_idx" ON "Member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_fundId_email_key" ON "Member"("fundId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Member_fundId_paymentReference_key" ON "Member"("fundId", "paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "Card_serialNumber_key" ON "Card"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Card_account_key" ON "Card"("account");

-- CreateIndex
CREATE INDEX "Card_memberId_idx" ON "Card"("memberId");

-- CreateIndex
CREATE INDEX "Card_status_idx" ON "Card"("status");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_primaryCardId_fkey" FOREIGN KEY ("primaryCardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
