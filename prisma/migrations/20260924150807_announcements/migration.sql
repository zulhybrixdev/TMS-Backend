-- CreateTable
CREATE TABLE `announcements` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('INFO', 'MAINTENANCE', 'DOWNTIME') NOT NULL DEFAULT 'INFO',
    `title_en` VARCHAR(160) NOT NULL,
    `title_ms` VARCHAR(160) NULL,
    `message_en` TEXT NOT NULL,
    `message_ms` TEXT NULL,
    `starts_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `affected_from` DATETIME(3) NULL,
    `affected_to` DATETIME(3) NULL,
    `persistent` BOOLEAN NOT NULL DEFAULT false,
    `created_by_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `announcements_starts_at_ends_at_idx`(`starts_at`, `ends_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
