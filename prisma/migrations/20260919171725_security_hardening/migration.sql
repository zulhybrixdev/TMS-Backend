-- AlterTable
ALTER TABLE `tenant_sso_configs` ADD COLUMN `allowed_email_domains` JSON NULL;

-- AlterTable
ALTER TABLE `tenants` ADD COLUMN `mfa_required` BOOLEAN NOT NULL DEFAULT false;
