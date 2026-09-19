-- AlterTable
ALTER TABLE `payment_templates` ADD COLUMN `frequency` ENUM('NONE', 'WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `last_run_at` DATETIME(3) NULL,
    ADD COLUMN `next_run_date` DATE NULL;

-- CreateIndex
CREATE INDEX `payment_templates_frequency_next_run_date_idx` ON `payment_templates`(`frequency`, `next_run_date`);
