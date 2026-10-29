-- Review S6: sync records non-canonical Safe wiring (modules, guard,
-- singleton, fallback handler) here; execution is paused while it is set.
ALTER TABLE "FundSafe" ADD COLUMN "configWarning" TEXT;
