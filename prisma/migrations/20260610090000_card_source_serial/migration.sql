-- Card source ("pull-from" card): mirror of CitizenPay's `source_serial`.
-- When a card can't cover a charge, CP pulls the missing amount from its
-- source card. CP is authoritative; this column is a display cache for the
-- cards list (written through on set, healed during card sync).

-- AlterTable
ALTER TABLE "Card" ADD COLUMN "sourceSerial" TEXT;
