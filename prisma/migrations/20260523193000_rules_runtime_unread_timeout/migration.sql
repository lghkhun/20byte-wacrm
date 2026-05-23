ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD COLUMN `messageId` VARCHAR(191) NULL,
  ADD COLUMN `waMessageId` VARCHAR(191) NULL;

CREATE INDEX `WhatsAppBroadcastRecipient_orgId_messageId_idx` ON `WhatsAppBroadcastRecipient`(`orgId`, `messageId`);
CREATE INDEX `WhatsAppBroadcastRecipient_orgId_waMessageId_idx` ON `WhatsAppBroadcastRecipient`(`orgId`, `waMessageId`);

CREATE TABLE `WhatsAppRulePendingCheck` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `flowId` VARCHAR(191) NULL,
  `ruleId` VARCHAR(191) NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `messageScope` VARCHAR(191) NOT NULL DEFAULT 'ANY',
  `sequenceId` VARCHAR(191) NULL,
  `broadcastId` VARCHAR(191) NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `messageId` VARCHAR(191) NOT NULL,
  `waMessageId` VARCHAR(191) NULL,
  `dueAt` DATETIME(3) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `processedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `wa_rule_pending_org_msg_event_uq` ON `WhatsAppRulePendingCheck`(`orgId`, `messageId`, `eventType`);
CREATE INDEX `WhatsAppRulePendingCheck_orgId_status_dueAt_idx` ON `WhatsAppRulePendingCheck`(`orgId`, `status`, `dueAt`);
CREATE INDEX `WhatsAppRulePendingCheck_orgId_flowId_status_dueAt_idx` ON `WhatsAppRulePendingCheck`(`orgId`, `flowId`, `status`, `dueAt`);
CREATE INDEX `WhatsAppRulePendingCheck_orgId_broadcastId_status_dueAt_idx` ON `WhatsAppRulePendingCheck`(`orgId`, `broadcastId`, `status`, `dueAt`);

ALTER TABLE `WhatsAppRulePendingCheck`
  ADD CONSTRAINT `WhatsAppRulePendingCheck_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppRulePendingCheck_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `WhatsAppFlow`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppRulePendingCheck_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `WhatsAppFlowRule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppRulePendingCheck_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppRulePendingCheck_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppRulePendingCheck_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD CONSTRAINT `WhatsAppBroadcastRecipient_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
