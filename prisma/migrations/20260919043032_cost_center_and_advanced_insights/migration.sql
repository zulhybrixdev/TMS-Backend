-- AlterTable
ALTER TABLE `approval_rules` ADD COLUMN `department` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `dashboard_widgets` JSON NULL,
    ADD COLUMN `department` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `report_definitions` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `base_report` VARCHAR(191) NOT NULL,
    `columns` JSON NOT NULL,
    `created_by_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `report_definitions_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `report_definitions` ADD CONSTRAINT `report_definitions_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `report_definitions` ADD CONSTRAINT `report_definitions_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
