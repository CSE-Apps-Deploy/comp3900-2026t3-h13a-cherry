CREATE TYPE "BookingPriceOfferStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED'
);

ALTER TABLE "payments"
  ADD COLUMN "stripeIdempotencyKey" TEXT,
  ADD COLUMN "paymentAttemptToken" TEXT;

CREATE TABLE "booking_price_offers" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "originalTotal" DECIMAL(10,2) NOT NULL,
  "proposedTotal" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AUD',
  "reason" TEXT,
  "status" "BookingPriceOfferStatus" NOT NULL DEFAULT 'PENDING',
  "createdById" TEXT NOT NULL,
  "respondedById" TEXT,
  "respondedAt" TIMESTAMP(3),
  "withdrawnById" TEXT,
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "booking_price_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "booking_price_offers_bookingId_status_idx"
  ON "booking_price_offers"("bookingId", "status");

CREATE INDEX "booking_price_offers_createdAt_idx"
  ON "booking_price_offers"("createdAt");

CREATE UNIQUE INDEX "booking_price_offers_one_pending_per_booking_idx"
  ON "booking_price_offers"("bookingId")
  WHERE "status" = 'PENDING';

ALTER TABLE "booking_price_offers"
  ADD CONSTRAINT "booking_price_offers_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
