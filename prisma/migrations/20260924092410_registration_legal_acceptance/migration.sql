-- AlterTable
ALTER TABLE `users` ADD COLUMN `privacy_accepted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `privacy_accepted_at` DATETIME(3) NULL,
    ADD COLUMN `privacy_version` VARCHAR(32) NULL,
    ADD COLUMN `terms_accepted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `terms_accepted_at` DATETIME(3) NULL,
    ADD COLUMN `terms_version` VARCHAR(32) NULL;
