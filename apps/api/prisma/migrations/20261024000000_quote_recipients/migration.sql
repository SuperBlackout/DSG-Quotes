-- CreateTable
CREATE TABLE "QuoteRecipient" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "addedById" TEXT,
    "addedByName" TEXT,
    "optInRequestedAt" TIMESTAMP(3),
    "optInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteRecipient_kind_address_idx" ON "QuoteRecipient"("kind", "address");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRecipient_quoteId_kind_address_key" ON "QuoteRecipient"("quoteId", "kind", "address");
