-- Data minimisation (GDPR Art. 5(1)(c)), 2026-10-01.
--
-- 1. User.country was filled from Hexclave's geo signal on onboarding and read
--    by nothing. Capture is removed in code; the values already stored go too.
--    The column stays so an older image can still start against this schema.
UPDATE "User" SET "country" = NULL WHERE "country" IS NOT NULL;

-- 2. The Auth.js (NextAuth) tables have been unused since the Hexclave
--    migration and still held OAuth access, refresh and id tokens in plain
--    text. Nothing reads or writes them.
DROP TABLE IF EXISTS "Account";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "VerificationToken";
