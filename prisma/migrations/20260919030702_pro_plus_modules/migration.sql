-- AlterTable
ALTER TABLE `approval_requests` ADD COLUMN `due_at` DATETIME(3) NULL,
    ADD COLUMN `escalated_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `approval_rules` ADD COLUMN `sla_hours` INTEGER NULL;

-- CreateTable
CREATE TABLE `beneficiaries` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NOT NULL,
    `account_name` VARCHAR(191) NOT NULL,
    `account_number` VARCHAR(191) NOT NULL,
    `bank_name` VARCHAR(191) NOT NULL,
    `currency_code` VARCHAR(191) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `beneficiaries_tenant_id_idx`(`tenant_id`),
    UNIQUE INDEX `beneficiaries_tenant_id_account_number_bank_name_key`(`tenant_id`, `account_number`, `bank_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_templates` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `beneficiary_name` VARCHAR(191) NOT NULL,
    `beneficiary_account` VARCHAR(191) NOT NULL,
    `beneficiary_bank` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `currency_code` VARCHAR(191) NOT NULL,
    `source_account_id` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `created_by_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payment_templates_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `approval_requests_status_due_at_idx` ON `approval_requests`(`status`, `due_at`);

-- AddForeignKey
ALTER TABLE `beneficiaries` ADD CONSTRAINT `beneficiaries_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_templates` ADD CONSTRAINT `payment_templates_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_templates` ADD CONSTRAINT `payment_templates_source_account_id_fkey` FOREIGN KEY (`source_account_id`) REFERENCES `bank_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_templates` ADD CONSTRAINT `payment_templates_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
