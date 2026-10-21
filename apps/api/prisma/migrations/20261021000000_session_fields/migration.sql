-- Columns the Shopify session storage library writes for online sessions.
ALTER TABLE "Session" ADD COLUMN "firstName" TEXT;
ALTER TABLE "Session" ADD COLUMN "lastName" TEXT;
ALTER TABLE "Session" ADD COLUMN "email" TEXT;
ALTER TABLE "Session" ADD COLUMN "accountOwner" BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "locale" TEXT;
ALTER TABLE "Session" ADD COLUMN "collaborator" BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "emailVerified" BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "Session" ADD COLUMN "refreshTokenExpires" TIMESTAMP(3);
