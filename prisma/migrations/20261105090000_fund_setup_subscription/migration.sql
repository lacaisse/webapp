-- Fund-setup checklist (services/fund-setup): after registering on Citizen Pay
-- a fund activates open banking on the Citizen Pay dashboard and accepts the
-- La Caisse hosting subscription.
--
-- citizenPayBusinessId caches the CP business that owns the treasury (and so
-- its Ponto bank connection) — the dashboard's banking/billing pages live under
-- that id. It is written from GET /v2/treasury on connect / key rotation and
-- backfilled lazily for older funds (resolveCitizenPayBusinessId in
-- services/citizenpay/business-id.ts). The subscription* / billing* columns
-- record the OWNER's acceptance and the details Citizen Pay's billing invoices
-- against; all are nullable, null = not accepted yet.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "citizenPayBusinessId" TEXT,
ADD COLUMN "subscriptionAcceptedAt" TIMESTAMP(3),
ADD COLUMN "subscriptionAcceptedByUserId" UUID,
ADD COLUMN "billingLegalName" TEXT,
ADD COLUMN "billingEmail" TEXT,
ADD COLUMN "billingAddress" TEXT,
ADD COLUMN "billingVatNumber" TEXT;

-- Free hosting. subscriptionWaivedAt / subscriptionWaiverReason mark a fund
-- whose subscription step is done without an acceptance; the optional
-- subscriptionWaiverCodeId says which code was redeemed. Codes are minted by
-- a platform admin (apex /admin/waivers) and redeemed by a fund OWNER on
-- Settings → Subscription.

-- CreateTable
CREATE TABLE "SubscriptionWaiverCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionWaiverCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionWaiverCode_code_key" ON "SubscriptionWaiverCode"("code");

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "subscriptionWaivedAt" TIMESTAMP(3),
ADD COLUMN "subscriptionWaiverReason" TEXT,
ADD COLUMN "subscriptionWaiverCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "Fund" ADD CONSTRAINT "Fund_subscriptionWaiverCodeId_fkey" FOREIGN KEY ("subscriptionWaiverCodeId") REFERENCES "SubscriptionWaiverCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- setupCompletedAt: first time all three steps were done; the dashboard
-- checklist then skips the live banking read.
ALTER TABLE "Fund" ADD COLUMN "setupCompletedAt" TIMESTAMP(3);
