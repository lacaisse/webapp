-- Hidden-from-signup flag for allocation tiers (issue #37). The tier stays
-- assignable by admins and keeps driving allocations; it is only withheld from
-- the public signup tier picker (issue #157). Distinct from archivedAt, which
-- retires a tier everywhere. Defaults to false so every existing tier keeps
-- its current, visible behaviour.

ALTER TABLE "AllocationTier" ADD COLUMN "hiddenAtSignup" BOOLEAN NOT NULL DEFAULT false;
