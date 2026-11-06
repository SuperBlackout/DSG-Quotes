-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'SHARED' AFTER 'DRAFT';

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN "rev" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sharedAt" TIMESTAMP(3),
ADD COLUMN "customerReady" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN "originLineId" TEXT;

-- CreateTable
CREATE TABLE "QuoteComment" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "afterLineId" TEXT,
    "authorType" "AuthorType" NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteComment_quoteId_createdAt_idx" ON "QuoteComment"("quoteId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuoteComment" ADD CONSTRAINT "QuoteComment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
