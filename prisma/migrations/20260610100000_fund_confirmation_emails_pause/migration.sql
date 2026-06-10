-- Per-fund pause switch for member-facing confirmation emails
-- (PAYMENT_CONFIRMATION + ALLOCATION_CONFIRMATION). NULL = sending normally;
-- set = paused since that instant. Skipped emails are not queued — resuming
-- does not send them retroactively.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "confirmationEmailsPausedAt" TIMESTAMP(3);
