-- Pending staff invitations. A FundInvite is materialized into a FundMember
-- when the invitee signs in/up with the matching email and accepts. Keyed
-- (fundId, email) so re-inviting replaces the prior pending invite.

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'FUND_INVITED';

-- CreateTable
CREATE TABLE "FundInvite" (
    "id"           TEXT NOT NULL,
    "fundId"       TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "role"         "FundRole" NOT NULL,
    "token"        TEXT NOT NULL,
    "invitedById"  UUID NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "acceptedAt"   TIMESTAMP(3),
    "acceptedById" UUID,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundInvite_token_key" ON "FundInvite"("token");

-- CreateIndex
CREATE UNIQUE INDEX "FundInvite_fundId_email_key" ON "FundInvite"("fundId", "email");

-- CreateIndex
CREATE INDEX "FundInvite_fundId_idx" ON "FundInvite"("fundId");

-- AddForeignKey
ALTER TABLE "FundInvite"
  ADD CONSTRAINT "FundInvite_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundInvite"
  ADD CONSTRAINT "FundInvite_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
