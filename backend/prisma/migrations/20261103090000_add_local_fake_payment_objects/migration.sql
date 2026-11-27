CREATE TABLE "fake_payment_objects" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fake_payment_objects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fake_payment_objects_idempotencyKey_key" ON "fake_payment_objects"("idempotencyKey");
