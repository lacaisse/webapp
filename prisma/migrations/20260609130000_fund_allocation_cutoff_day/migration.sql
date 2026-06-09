-- FIXED_PERIOD funds: the day-of-month at which each monthly allocation period
-- hits its cutoff and the batch mint fires. Auto-created periods derive their
-- cutoffDate from this value (clamped to the month length, so 31 = last day of
-- every month). Default 31 = end of month. Ignored for PAY_AND_GO funds.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "allocationCutoffDay" INTEGER NOT NULL DEFAULT 31;
