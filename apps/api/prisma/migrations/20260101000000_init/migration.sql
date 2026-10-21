-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'QUOTE_READY', 'CHANGES_REQUESTED', 'ACCEPTED', 'ORDERED', 'EXPIRED', 'DECLINED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AuthorType" AS ENUM ('CUSTOMER', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "LineSet" AS ENUM ('CUSTOMER', 'STAFF', 'VERSION');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyLocationId" TEXT,
    "name" TEXT NOT NULL,
    "poNumber" TEXT,
    "siteAddress" TEXT,
    "createdById" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "jobId" TEXT,
    "title" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerEmail" TEXT,
    "companyId" TEXT,
    "companyName" TEXT,
    "companyLocationId" TEXT,
    "assignedRepId" TEXT,
    "teamId" TEXT,
    "createdByStaffId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "poNumber" TEXT,
    "notesToSales" TEXT,
    "neededBy" TIMESTAMP(3),
    "shipToAddress" JSONB,
    "expiresAt" TIMESTAMP(3),
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "marginPct" DECIMAL(7,2),
    "belowFloor" BOOLEAN NOT NULL DEFAULT false,
    "workingFreight" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "workingExpiresAt" TIMESTAMP(3),
    "workingRepNote" TEXT,
    "workingInternalNote" TEXT,
    "draftOrderId" TEXT,
    "draftOrderInvoiceUrl" TEXT,
    "draftOrderVersion" INTEGER,
    "draftOrderStatus" TEXT,
    "orderId" TEXT,
    "watchers" JSONB NOT NULL DEFAULT '[]',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "freight" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxEstimate" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "repNote" TEXT,
    "internalNote" TEXT,

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "versionId" TEXT,
    "set" "LineSet" NOT NULL DEFAULT 'CUSTOMER',
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "qty" INTEGER NOT NULL,
    "listPrice" DECIMAL(12,2) NOT NULL,
    "quotedPrice" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2),
    "lineNote" TEXT,
    "floorApproved" BOOLEAN NOT NULL DEFAULT false,
    "floorApprovedById" TEXT,
    "addedBy" "AuthorType" NOT NULL DEFAULT 'CUSTOMER',
    "position" INTEGER NOT NULL,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "authorType" "AuthorType" NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "channel" "Channel" NOT NULL DEFAULT 'WEB',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPref" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "staffId" TEXT,
    "event" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "smsOptInAt" TIMESTAMP(3),
    "smsConsentText" TEXT,
    "quietStart" TEXT,
    "quietEnd" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',

    CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "watchers" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveQuote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("shop","key")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" "AuthorType" NOT NULL,
    "actorId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyStaffId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "teamId" TEXT,
    "priceFloorPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "isManager" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_shop_companyId_idx" ON "Job"("shop", "companyId");

-- CreateIndex
CREATE INDEX "Job_shop_companyLocationId_idx" ON "Job"("shop", "companyLocationId");

-- CreateIndex
CREATE INDEX "Quote_shop_companyLocationId_status_idx" ON "Quote"("shop", "companyLocationId", "status");

-- CreateIndex
CREATE INDEX "Quote_shop_companyId_status_idx" ON "Quote"("shop", "companyId", "status");

-- CreateIndex
CREATE INDEX "Quote_shop_assignedRepId_status_idx" ON "Quote"("shop", "assignedRepId", "status");

-- CreateIndex
CREATE INDEX "Quote_shop_status_updatedAt_idx" ON "Quote"("shop", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_shop_number_key" ON "Quote"("shop", "number");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_quoteId_versionNo_key" ON "QuoteVersion"("quoteId", "versionNo");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_set_idx" ON "QuoteLine"("quoteId", "set");

-- CreateIndex
CREATE INDEX "QuoteLine_versionId_idx" ON "QuoteLine"("versionId");

-- CreateIndex
CREATE INDEX "Message_quoteId_createdAt_idx" ON "Message"("quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationPref_shop_customerId_idx" ON "NotificationPref"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPref_shop_customerId_staffId_event_key" ON "NotificationPref"("shop", "customerId", "staffId", "event");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_shop_customerId_key" ON "CustomerProfile"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ActiveQuote_shop_customerId_key" ON "ActiveQuote"("shop", "customerId");

-- CreateIndex
CREATE INDEX "Event_notifiedAt_createdAt_idx" ON "Event"("notifiedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Event_quoteId_createdAt_idx" ON "Event"("quoteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_shop_shopifyStaffId_key" ON "Staff"("shop", "shopifyStaffId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "QuoteVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
