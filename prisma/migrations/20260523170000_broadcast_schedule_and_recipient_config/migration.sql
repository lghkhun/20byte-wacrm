ALTER TABLE `WhatsAppBroadcast`
  ADD COLUMN `recipientMode` VARCHAR(191) NOT NULL DEFAULT 'SEGMENT',
  ADD COLUMN `segment` VARCHAR(191) NOT NULL DEFAULT 'all_leads',
  ADD COLUMN `selectedCustomerIdsJson` LONGTEXT NULL,
  ADD COLUMN `filtersJson` LONGTEXT NULL,
  ADD COLUMN `batchSize` INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN `batchIntervalSeconds` INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN `scheduledAt` DATETIME(3) NULL;

ALTER TABLE `WhatsAppBroadcastRecipient`
  ADD COLUMN `dueAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `attemptCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastAttemptAt` DATETIME(3) NULL;

CREATE INDEX `WhatsAppBroadcast_orgId_scheduledAt_idx` ON `WhatsAppBroadcast`(`orgId`, `scheduledAt`);
CREATE INDEX `WhatsAppBroadcastRecipient_orgId_broadcastId_status_dueAt_idx` ON `WhatsAppBroadcastRecipient`(`orgId`, `broadcastId`, `status`, `dueAt`);
