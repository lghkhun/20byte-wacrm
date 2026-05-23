CREATE TABLE `WhatsAppFlowRule` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NOT NULL,
  `createdByUserId` VARCHAR(191) NULL,
  `triggerType` VARCHAR(191) NOT NULL,
  `conditionExpr` VARCHAR(191) NOT NULL,
  `actionType` VARCHAR(191) NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `orderIndex` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `WhatsAppFlowRule_orgId_flowId_isActive_createdAt_idx`(`orgId`, `flowId`, `isActive`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppBroadcast` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdByUserId` VARCHAR(191) NULL,
  `name` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT', 'RUNNING', 'COMPLETED', 'CANCELED') NOT NULL DEFAULT 'DRAFT',
  `messageMode` VARCHAR(191) NOT NULL,
  `templateName` VARCHAR(191) NULL,
  `templateLanguageCode` VARCHAR(191) NULL,
  `templateCategory` ENUM('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE') NULL,
  `templateComponentsJson` LONGTEXT NULL,
  `text` LONGTEXT NULL,
  `launchedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `canceledAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `WhatsAppBroadcast_orgId_status_createdAt_idx`(`orgId`, `status`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WhatsAppBroadcastRecipient` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `broadcastId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `enrollmentId` VARCHAR(191) NULL,
  `executionId` VARCHAR(191) NULL,
  `phoneE164` VARCHAR(191) NOT NULL,
  `status` ENUM('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'STOPPED') NOT NULL DEFAULT 'PENDING',
  `errorCode` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `WhatsAppBroadcastRecipient_broadcastId_conversationId_key`(`broadcastId`, `conversationId`),
  INDEX `WhatsAppBroadcastRecipient_orgId_broadcastId_status_idx`(`orgId`, `broadcastId`, `status`),
  INDEX `WhatsAppBroadcastRecipient_orgId_phoneE164_status_idx`(`orgId`, `phoneE164`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WhatsAppFlowRule`
  ADD CONSTRAINT `WhatsAppFlowRule_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppFlowRule`
  ADD CONSTRAINT `WhatsAppFlowRule_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppFlowRule`
  ADD CONSTRAINT `WhatsAppFlowRule_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WhatsAppBroadcast`
  ADD CONSTRAINT `WhatsAppBroadcast_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcast`
  ADD CONSTRAINT `WhatsAppBroadcast_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_broadcastId_fkey` FOREIGN KEY (`broadcastId`) REFERENCES `WhatsAppBroadcast`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_enrollmentId_fkey` FOREIGN KEY (`enrollmentId`) REFERENCES `WhatsAppEnrollment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `WhatsAppExecution`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
