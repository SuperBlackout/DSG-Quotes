-- Contract 0.2.0 follow-ups (hand-maintained, mirrors prisma/schema.prisma; test/schema-sync.test.ts guards drift).

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('rep', 'manager', 'admin');

-- Quote: currency, payment terms and contact phone snapshots
ALTER TABLE "Quote" ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Quote" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "Quote" ADD COLUMN "customerContactPhone" TEXT;

-- Staff: role replaces isManager; personal price floor becomes an optional override; team membership moves to TeamMember
ALTER TABLE "Staff" ADD COLUMN "role" "StaffRole" NOT NULL DEFAULT 'rep';
ALTER TABLE "Staff" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Staff" SET "role" = 'manager' WHERE "isManager" = true;
ALTER TABLE "Staff" DROP COLUMN "isManager";
ALTER TABLE "Staff" DROP COLUMN "teamId";
ALTER TABLE "Staff" ALTER COLUMN "priceFloorPct" DROP NOT NULL;
ALTER TABLE "Staff" ALTER COLUMN "priceFloorPct" DROP DEFAULT;
-- The old column defaulted to 15 for everyone; only genuinely personal values stay as overrides.
UPDATE "Staff" SET "priceFloorPct" = NULL WHERE "priceFloorPct" = 15;

-- Notification prefs: CHANGES_REQUESTED is staff-only and no longer a customer preference
DELETE FROM "NotificationPref" WHERE "event" = 'CHANGES_REQUESTED' AND "customerId" IS NOT NULL;

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "teamId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId","staffId")
);

-- CreateTable
CREATE TABLE "ShopSetting" (
    "shop" TEXT NOT NULL,
    "defaultPriceFloorPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "defaultTeamId" TEXT,
    "autoAssignByCompany" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSetting_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "repId" TEXT,
    "teamId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedReply" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "ownerId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT,
    "channel" "Channel" NOT NULL,
    "to" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOptOut" (
    "phone" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE INDEX "Team_shop_idx" ON "Team"("shop");

-- CreateIndex
CREATE INDEX "TeamMember_staffId_idx" ON "TeamMember"("staffId");

-- CreateIndex
CREATE INDEX "RoutingRule_shop_companyId_idx" ON "RoutingRule"("shop", "companyId");

-- CreateIndex
CREATE INDEX "SavedReply_shop_shared_idx" ON "SavedReply"("shop", "shared");

-- CreateIndex
CREATE INDEX "SavedReply_shop_ownerId_idx" ON "SavedReply"("shop", "ownerId");

-- CreateIndex
CREATE INDEX "NotificationLog_quoteId_createdAt_idx" ON "NotificationLog"("quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_to_createdAt_idx" ON "NotificationLog"("to", "createdAt");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
