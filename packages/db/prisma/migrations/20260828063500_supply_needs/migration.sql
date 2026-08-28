-- CreateEnum
CREATE TYPE "SupplyNeedStatus" AS ENUM ('OPEN', 'WATCH', 'RESOLVED');

-- CreateTable
CREATE TABLE "SupplyNeed" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "status" "SupplyNeedStatus" NOT NULL DEFAULT 'OPEN',
    "health" TEXT NOT NULL,
    "targetAvailable" INTEGER NOT NULL,
    "availableNow" INTEGER NOT NULL,
    "supplyGap" INTEGER NOT NULL,
    "requests7d" INTEGER NOT NULL,
    "priorityScore" DOUBLE PRECISION NOT NULL,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyNeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplyNeed_cityId_categoryId_key" ON "SupplyNeed"("cityId", "categoryId");

-- CreateIndex
CREATE INDEX "SupplyNeed_status_priorityScore_idx" ON "SupplyNeed"("status", "priorityScore");

-- CreateIndex
CREATE INDEX "SupplyNeed_cityId_status_priorityScore_idx" ON "SupplyNeed"("cityId", "status", "priorityScore");

-- AddForeignKey
ALTER TABLE "SupplyNeed" ADD CONSTRAINT "SupplyNeed_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyNeed" ADD CONSTRAINT "SupplyNeed_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
