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
