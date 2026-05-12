-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "website" TEXT,
    "conditions" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "citizenPayPlaceId" TEXT,
    "citizenPayActivatedAt" TIMESTAMP(3),
    "citizenPayLastSyncedAt" TIMESTAMP(3),
    "status" "MerchantStatus" NOT NULL DEFAULT 'PENDING',
    "applicationData" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "reviewerId" UUID,
    "reviewNote" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Merchant_fundId_status_idx" ON "Merchant"("fundId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_fundId_name_key" ON "Merchant"("fundId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_fundId_citizenPayPlaceId_key" ON "Merchant"("fundId", "citizenPayPlaceId");

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
