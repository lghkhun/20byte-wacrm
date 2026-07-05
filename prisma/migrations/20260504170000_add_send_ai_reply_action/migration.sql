-- Add SEND_AI_REPLY to AiAutomationActionType enum (MySQL)
ALTER TABLE `AiAutomationAction`
  MODIFY `type` ENUM('SEND_MESSAGE', 'SEND_AI_REPLY', 'SEND_INVOICE', 'ASSIGN_CS', 'NOTIFY_CS') NOT NULL;
