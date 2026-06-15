-- Per-fund custom From address for member-facing transactional emails
-- (verification, welcome, activation, invitation, payment + allocation
-- confirmation, referral bonus). Bare address; the display name is the fund
-- name at send time. NULL = fall back to the platform EMAIL_FROM. Merchant/team
-- and Supabase auth emails are unaffected.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "senderEmail" TEXT;
