-- The member's preferred language, captured from the request locale at
-- self-signup so every email we send them matches the language they registered
-- in. Null for admin-created / imported members (preference unknown) — the
-- email layer falls back to the fund's default locale. A supported-locale code
-- (e.g. "fr", "en"); see services/i18n/config.ts.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN "locale" TEXT;
