-- Review S5: accepting a staff invite now requires the account's email to be
-- verified when the account predates the invite (services/fund-team/
-- invite-rules.ts). Email verification has been off since launch, so every
-- existing account is unverified — including every current team member, who
-- would be refused the next time a colleague invites them to another fund.
-- An account that already holds a fund membership got there through an
-- invite (its token reached the inbox) or was set up by the platform team:
-- treat those as verified. Accounts with no membership stay unverified and
-- verify through a password reset or a fresh invite sign-up.
UPDATE "User" u
SET "emailVerified" = true
WHERE "emailVerified" = false
  AND EXISTS (SELECT 1 FROM "FundMember" m WHERE m."userId" = u.id);
