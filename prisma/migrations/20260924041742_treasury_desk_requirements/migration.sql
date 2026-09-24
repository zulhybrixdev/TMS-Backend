-- AlterTable
ALTER TABLE `bank_accounts` ADD COLUMN `overdraft_limit` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `site_name` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `incoming_transactions` ADD COLUMN `clearing_date` DATE NULL,
    ADD COLUMN `float_days` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `invoice_number` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `invoice_number` VARCHAR(100) NULL,
    ADD COLUMN `payment_method` ENUM('TRANSFER', 'CHEQUE', 'BANK_DRAFT') NOT NULL DEFAULT 'TRANSFER';

-- AlterTable
ALTER TABLE `transactions` ADD COLUMN `related_ba_id` VARCHAR(191) NULL,
    MODIFY `type` ENUM('PAYMENT_OUT', 'INCOMING_IN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'BA_DRAWDOWN', 'BA_SETTLEMENT') NOT NULL;

-- CreateTable
CREATE TABLE `banker_acceptances` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `reference_no` VARCHAR(191) NOT NULL,
    `credit_account_id` VARCHAR(191) NOT NULL,
    `settlement_account_id` VARCHAR(191) NOT NULL,
    `currency_code` VARCHAR(191) NOT NULL,
    `face_amount` DECIMAL(18, 2) NOT NULL,
    `proceeds_amount` DECIMAL(18, 2) NOT NULL,
    `drawdown_date` DATE NOT NULL,
    `maturity_date` DATE NOT NULL,
    `status` ENUM('OUTSTANDING', 'SETTLED') NOT NULL DEFAULT 'OUTSTANDING',
    `settled_date` DATE NULL,
    `settled_amount` DECIMAL(18, 2) NULL,
    `description` VARCHAR(191) NULL,
    `created_by_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `banker_acceptances_tenant_id_idx`(`tenant_id`),
    INDEX `banker_acceptances_status_maturity_date_idx`(`status`, `maturity_date`),
    INDEX `banker_acceptances_drawdown_date_idx`(`drawdown_date`),
    UNIQUE INDEX `banker_acceptances_tenant_id_reference_no_key`(`tenant_id`, `reference_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instrument_quotas` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `payment_method` ENUM('TRANSFER', 'CHEQUE', 'BANK_DRAFT') NOT NULL,
    `bank_id` VARCHAR(191) NULL,
    `daily_amount_limit` DECIMAL(18, 2) NULL,
    `daily_count_limit` INTEGER NULL,
    `currency_code` VARCHAR(191) NOT NULL DEFAULT 'MYR',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `instrument_quotas_tenant_id_idx`(`tenant_id`),
    INDEX `instrument_quotas_bank_id_idx`(`bank_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `incoming_transactions_clearing_date_idx` ON `incoming_transactions`(`clearing_date`);

-- CreateIndex
CREATE INDEX `payments_payment_method_payment_date_idx` ON `payments`(`payment_method`, `payment_date`);

-- AddForeignKey
ALTER TABLE `banker_acceptances` ADD CONSTRAINT `banker_acceptances_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `banker_acceptances` ADD CONSTRAINT `banker_acceptances_credit_account_id_fkey` FOREIGN KEY (`credit_account_id`) REFERENCES `bank_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `banker_acceptances` ADD CONSTRAINT `banker_acceptances_settlement_account_id_fkey` FOREIGN KEY (`settlement_account_id`) REFERENCES `bank_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `banker_acceptances` ADD CONSTRAINT `banker_acceptances_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instrument_quotas` ADD CONSTRAINT `instrument_quotas_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instrument_quotas` ADD CONSTRAINT `instrument_quotas_bank_id_fkey` FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
