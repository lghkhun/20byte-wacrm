-- AI Sales Engine MVP schema

CREATE TABLE `AiAgentConfig` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `role` ENUM('SALES_ASSISTANT', 'CUSTOMER_SUPPORT', 'ADMIN_ASSISTANT', 'CUSTOM') NOT NULL DEFAULT 'SALES_ASSISTANT',
  `goal` ENUM('ANSWER_QUESTION', 'COLLECT_LEAD', 'PUSH_TO_BUY', 'CLOSE_DEAL') NOT NULL DEFAULT 'ANSWER_QUESTION',
  `tone` ENUM('FRIENDLY', 'CASUAL', 'PROFESSIONAL', 'PERSUASIVE') NOT NULL DEFAULT 'FRIENDLY',
  `salesMode` ENUM('SOFT_SELLING', 'HARD_SELLING', 'INFORMATIVE') NOT NULL DEFAULT 'SOFT_SELLING',
  `businessName` VARCHAR(191) NULL,
  `advancedPrompt` TEXT NULL,
  `stopIfHumanReply` BOOLEAN NOT NULL DEFAULT true,
  `typingDelayMs` INTEGER NOT NULL DEFAULT 1200,
  `multiBubbleReply` BOOLEAN NOT NULL DEFAULT false,
  `confidenceThreshold` INTEGER NOT NULL DEFAULT 70,
  `provider` ENUM('OPENROUTER') NOT NULL DEFAULT 'OPENROUTER',
  `modelFree` VARCHAR(191) NOT NULL DEFAULT 'meta-llama/llama-3.1-8b-instruct:free',
  `modelPaid` VARCHAR(191) NOT NULL DEFAULT 'anthropic/claude-3-haiku',
  `activeModelTier` VARCHAR(191) NOT NULL DEFAULT 'FREE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `AiAgentConfig_orgId_key`(`orgId`),
  INDEX `AiAgentConfig_orgId_idx`(`orgId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiKnowledge` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `type` ENUM('PRODUCT', 'FAQ', 'SOP', 'OBJECTION_HANDLING', 'CUSTOM') NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `question` TEXT NULL,
  `answer` TEXT NULL,
  `sourceUrl` VARCHAR(191) NULL,
  `fileUrl` VARCHAR(191) NULL,
  `fileName` VARCHAR(191) NULL,
  `mimeType` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `priority` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `AiKnowledge_orgId_type_idx`(`orgId`, `type`),
  INDEX `AiKnowledge_orgId_isActive_idx`(`orgId`, `isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiAutomation` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `trigger` ENUM('CHAT_INCOMING', 'NO_REPLY', 'INVOICE_CREATED', 'INVOICE_UNPAID', 'TAG_ADDED') NOT NULL,
  `delayMinutes` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `AiAutomation_orgId_enabled_idx`(`orgId`, `enabled`),
  INDEX `AiAutomation_orgId_trigger_idx`(`orgId`, `trigger`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiAutomationCondition` (
  `id` VARCHAR(191) NOT NULL,
  `automationId` VARCHAR(191) NOT NULL,
  `type` ENUM('CUSTOMER_TAG', 'INVOICE_STATUS', 'CONVERSATION_STATUS', 'NO_HUMAN_REPLY') NOT NULL,
  `operator` VARCHAR(191) NOT NULL DEFAULT 'EQUALS',
  `value` VARCHAR(191) NOT NULL,

  INDEX `AiAutomationCondition_automationId_idx`(`automationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiAutomationAction` (
  `id` VARCHAR(191) NOT NULL,
  `automationId` VARCHAR(191) NOT NULL,
  `type` ENUM('SEND_MESSAGE', 'SEND_INVOICE', 'ASSIGN_CS', 'NOTIFY_CS') NOT NULL,
  `payloadJson` TEXT NOT NULL,

  INDEX `AiAutomationAction_automationId_idx`(`automationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiTokenBalance` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `totalTokens` INTEGER NOT NULL DEFAULT 0,
  `usedTokens` INTEGER NOT NULL DEFAULT 0,
  `remainingTokens` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `AiTokenBalance_orgId_key`(`orgId`),
  INDEX `AiTokenBalance_orgId_idx`(`orgId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiUsage` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `type` ENUM('AUTO_REPLY', 'SUGGESTED_REPLY', 'KNOWLEDGE_TEST', 'AUTOMATION') NOT NULL,
  `conversationId` VARCHAR(191) NULL,
  `messageId` VARCHAR(191) NULL,
  `customerId` VARCHAR(191) NULL,
  `provider` ENUM('OPENROUTER') NOT NULL DEFAULT 'OPENROUTER',
  `model` VARCHAR(191) NOT NULL,
  `inputTokens` INTEGER NOT NULL DEFAULT 0,
  `outputTokens` INTEGER NOT NULL DEFAULT 0,
  `totalTokens` INTEGER NOT NULL DEFAULT 0,
  `costEstimateIdr` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AiUsage_orgId_createdAt_idx`(`orgId`, `createdAt`),
  INDEX `AiUsage_conversationId_idx`(`conversationId`),
  INDEX `AiUsage_customerId_idx`(`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiResponseLog` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NULL,
  `customerId` VARCHAR(191) NULL,
  `promptPreview` TEXT NULL,
  `responseText` TEXT NOT NULL,
  `confidenceScore` INTEGER NULL,
  `wasSent` BOOLEAN NOT NULL DEFAULT false,
  `wasEdited` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AiResponseLog_orgId_createdAt_idx`(`orgId`, `createdAt`),
  INDEX `AiResponseLog_conversationId_idx`(`conversationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AiAgentConfig` ADD CONSTRAINT `AiAgentConfig_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiKnowledge` ADD CONSTRAINT `AiKnowledge_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiAutomation` ADD CONSTRAINT `AiAutomation_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiAutomationCondition` ADD CONSTRAINT `AiAutomationCondition_automationId_fkey` FOREIGN KEY (`automationId`) REFERENCES `AiAutomation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiAutomationAction` ADD CONSTRAINT `AiAutomationAction_automationId_fkey` FOREIGN KEY (`automationId`) REFERENCES `AiAutomation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiTokenBalance` ADD CONSTRAINT `AiTokenBalance_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiUsage` ADD CONSTRAINT `AiUsage_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiUsage` ADD CONSTRAINT `AiUsage_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiUsage` ADD CONSTRAINT `AiUsage_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiResponseLog` ADD CONSTRAINT `AiResponseLog_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiResponseLog` ADD CONSTRAINT `AiResponseLog_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiResponseLog` ADD CONSTRAINT `AiResponseLog_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
