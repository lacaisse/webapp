-- Multi-step public signup forms, plus the two redirect targets an external
-- website needs to hand the flow back and forth.
--
-- Steps are optional and additive: a fund with no OnboardingStep rows keeps
-- the existing single-page form, and every existing OnboardingField starts
-- with a NULL stepId (= renders in the first step). No backfill needed.

-- 1. Steps ------------------------------------------------------------------

CREATE TABLE "OnboardingStep" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "target" "OnboardingTarget" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingStep_fundId_target_idx"
    ON "OnboardingStep"("fundId", "target");

ALTER TABLE "OnboardingStep"
    ADD CONSTRAINT "OnboardingStep_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Field → step assignment ------------------------------------------------
-- SetNull, not Cascade: dropping a step must never delete the field
-- definitions that give historical applicationData its meaning.

ALTER TABLE "OnboardingField" ADD COLUMN "stepId" TEXT;

CREATE INDEX "OnboardingField_stepId_idx" ON "OnboardingField"("stepId");

ALTER TABLE "OnboardingField"
    ADD CONSTRAINT "OnboardingField_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "OnboardingStep"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Cancel / error redirects -----------------------------------------------
-- Siblings of the existing memberSignupSuccessUrl. Admin-configured only:
-- the public form never takes a redirect target from the query string.

ALTER TABLE "Fund" ADD COLUMN "memberSignupCancelUrl" TEXT;
ALTER TABLE "Fund" ADD COLUMN "memberSignupErrorUrl" TEXT;
