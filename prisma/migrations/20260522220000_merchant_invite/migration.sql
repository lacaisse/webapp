-- Track an in-flight Citizen Pay merchant invite per Merchant row.
-- CP keys invites by (treasury, email) and auto-rejects a prior pending
-- invite when a new one is minted for the same pair — so we only need
-- one in-flight invite per Merchant, not a separate table. Fields are
-- cleared by the callback handler (accepted → citizenPayBusinessId
-- gets set; rejected → cleared without a businessId).

ALTER TABLE "Merchant" ADD COLUMN "citizenPayInviteToken"     TEXT;
ALTER TABLE "Merchant" ADD COLUMN "citizenPayInviteEmail"     TEXT;
ALTER TABLE "Merchant" ADD COLUMN "citizenPayInviteSentAt"    TIMESTAMP(3);
ALTER TABLE "Merchant" ADD COLUMN "citizenPayInviteExpiresAt" TIMESTAMP(3);

-- Token is globally unique on CP's side, but we scope to fund as a
-- defence-in-depth — the callback only trusts tokens that match the
-- fund of the host that received the redirect.
CREATE UNIQUE INDEX "Merchant_fundId_citizenPayInviteToken_key"
  ON "Merchant"("fundId", "citizenPayInviteToken");
