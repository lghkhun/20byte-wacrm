CREATE TABLE `WhatsAppFlow` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdByUserId` VARCHAR(191) NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `status` ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `triggerType` ENUM('MANUAL') NOT NULL DEFAULT 'MANUAL',
  `isTemplateOnly` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `WhatsAppFlow_orgId_status_createdAt_idx`(`orgId`, `status`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppFlowNode` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `type` ENUM('SEND_TEMPLATE', 'DELAY', 'STOP') NOT NULL,
  `configJson` LONGTEXT NOT NULL,
  `positionX` INTEGER NOT NULL DEFAULT 0,
  `positionY` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `WhatsAppFlowNode_flowId_key_key`(`flowId`, `key`),
  INDEX `WhatsAppFlowNode_orgId_flowId_idx`(`orgId`, `flowId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppFlowEdge` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NOT NULL,
  `fromNodeKey` VARCHAR(191) NOT NULL,
  `toNodeKey` VARCHAR(191) NOT NULL,
  `conditionKey` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `WhatsAppFlowEdge_orgId_flowId_idx`(`orgId`, `flowId`),
  INDEX `WhatsAppFlowEdge_flowId_fromNodeKey_idx`(`flowId`, `fromNodeKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppEnrollment` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `enrolledByUserId` VARCHAR(191) NULL,
  `status` ENUM('ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED') NOT NULL DEFAULT 'ACTIVE',
  `currentNodeKey` VARCHAR(191) NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `WhatsAppEnrollment_orgId_flowId_status_createdAt_idx`(`orgId`, `flowId`, `status`, `createdAt`),
  INDEX `WhatsAppEnrollment_orgId_conversationId_status_idx`(`orgId`, `conversationId`, `status`),
  INDEX `WhatsAppEnrollment_orgId_customerId_status_idx`(`orgId`, `customerId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppExecution` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NOT NULL,
  `enrollmentId` VARCHAR(191) NOT NULL,
  `nodeKey` VARCHAR(191) NOT NULL,
  `nodeType` ENUM('SEND_TEMPLATE', 'DELAY', 'STOP') NOT NULL,
  `status` ENUM('QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'STOPPED') NOT NULL DEFAULT 'QUEUED',
  `stopReason` ENUM('FLOW_COMPLETED', 'MANUAL_STOP', 'TEMPLATE_ONLY_ENFORCED', 'ENROLLMENT_NOT_ACTIVE', 'CONVERSATION_NOT_FOUND', 'SEND_FAILED') NULL,
  `dueAt` DATETIME(3) NOT NULL,
  `executedAt` DATETIME(3) NULL,
  `messageId` VARCHAR(191) NULL,
  `waMessageId` VARCHAR(191) NULL,
  `errorCode` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `payloadJson` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `WhatsAppExecution_orgId_status_dueAt_idx`(`orgId`, `status`, `dueAt`),
  INDEX `WhatsAppExecution_orgId_enrollmentId_createdAt_idx`(`orgId`, `enrollmentId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppComplianceEvent` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NULL,
  `enrollmentId` VARCHAR(191) NULL,
  `executionId` VARCHAR(191) NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `decision` VARCHAR(191) NOT NULL,
  `reasonCode` VARCHAR(191) NULL,
  `reasonDetail` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `WhatsAppComplianceEvent_orgId_createdAt_idx`(`orgId`, `createdAt`),
  INDEX `WhatsAppComplianceEvent_orgId_eventType_createdAt_idx`(`orgId`, `eventType`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WhatsAppFlow` ADD CONSTRAINT `WhatsAppFlow_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppFlow` ADD CONSTRAINT `WhatsAppFlow_createdByUserId_fkey`
  FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WhatsAppFlowNode` ADD CONSTRAINT `WhatsAppFlowNode_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppFlowNode` ADD CONSTRAINT `WhatsAppFlowNode_flowId_fkey`
  FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WhatsAppFlowEdge` ADD CONSTRAINT `WhatsAppFlowEdge_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppFlowEdge` ADD CONSTRAINT `WhatsAppFlowEdge_flowId_fkey`
  FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WhatsAppEnrollment` ADD CONSTRAINT `WhatsAppEnrollment_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppEnrollment` ADD CONSTRAINT `WhatsAppEnrollment_flowId_fkey`
  FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `WhatsAppEnrollment` ADD CONSTRAINT `WhatsAppEnrollment_conversationId_fkey`
  FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppEnrollment` ADD CONSTRAINT `WhatsAppEnrollment_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppEnrollment` ADD CONSTRAINT `WhatsAppEnrollment_enrolledByUserId_fkey`
  FOREIGN KEY (`enrolledByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WhatsAppExecution` ADD CONSTRAINT `WhatsAppExecution_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppExecution` ADD CONSTRAINT `WhatsAppExecution_flowId_fkey`
  FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `WhatsAppExecution` ADD CONSTRAINT `WhatsAppExecution_enrollmentId_fkey`
  FOREIGN KEY (`enrollmentId`) REFERENCES `WhatsAppEnrollment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `WhatsAppExecution` ADD CONSTRAINT `WhatsAppExecution_messageId_fkey`
  FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WhatsAppComplianceEvent` ADD CONSTRAINT `WhatsAppComplianceEvent_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
