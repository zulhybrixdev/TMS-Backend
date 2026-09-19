-- CreateTable
CREATE TABLE `fx_rates` (
    `id` VARCHAR(191) NOT NULL,
    `base_currency` VARCHAR(191) NOT NULL,
    `quote_currency` VARCHAR(191) NOT NULL,
    `rate` DECIMAL(18, 8) NOT NULL,
    `rate_date` DATE NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'frankfurter',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `fx_rates_base_currency_rate_date_idx`(`base_currency`, `rate_date`),
    UNIQUE INDEX `fx_rates_base_currency_quote_currency_rate_date_provider_key`(`base_currency`, `quote_currency`, `rate_date`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
