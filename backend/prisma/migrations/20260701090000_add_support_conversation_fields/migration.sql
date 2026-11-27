CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'SUPPORT');

CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');

ALTER TABLE "conversations"
ADD COLUMN "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
ADD COLUMN "supportRequesterId" TEXT,
ADD COLUMN "supportAssignedAdminId" TEXT,
ADD COLUMN "closedById" TEXT,
ADD COLUMN "closedAt" TIMESTAMP(3);

CREATE INDEX "conversations_type_idx" ON "conversations"("type");
CREATE INDEX "conversations_status_idx" ON "conversations"("status");
CREATE INDEX "conversations_supportRequesterId_idx" ON "conversations"("supportRequesterId");
CREATE INDEX "conversations_supportAssignedAdminId_idx" ON "conversations"("supportAssignedAdminId");
