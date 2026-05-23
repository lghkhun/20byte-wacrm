ALTER TABLE `WhatsAppFlow`
  MODIFY `triggerType` ENUM('MANUAL', 'CHAT_INCOMING') NOT NULL DEFAULT 'MANUAL';

ALTER TABLE `WhatsAppFlowNode`
  MODIFY `type` ENUM('SEND_TEMPLATE', 'SEND_TEXT', 'DELAY', 'STOP') NOT NULL;

ALTER TABLE `WhatsAppExecution`
  MODIFY `nodeType` ENUM('SEND_TEMPLATE', 'SEND_TEXT', 'DELAY', 'STOP') NOT NULL;

CREATE TABLE `WhatsAppSuppression` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NULL,
  `phoneE164` VARCHAR(191) NOT NULL,
  `reason` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `wa_supp_org_cust_conv_phone_uq`(`orgId`, `customerId`, `conversationId`, `phoneE164`),
  INDEX `WhatsAppSuppression_orgId_isActive_createdAt_idx`(`orgId`, `isActive`, `createdAt`),
  INDEX `WhatsAppSuppression_orgId_phoneE164_isActive_idx`(`orgId`, `phoneE164`, `isActive`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WhatsAppSuppression`
  ADD CONSTRAINT `WhatsAppSuppression_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppSuppression`
  ADD CONSTRAINT `WhatsAppSuppression_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `WhatsAppSuppression`
  ADD CONSTRAINT `WhatsAppSuppression_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
