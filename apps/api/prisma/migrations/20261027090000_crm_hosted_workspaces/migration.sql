-- CreateEnum
CREATE TYPE "crm_binding_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "crm_credential_status" AS ENUM ('active', 'revoked');

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "party_id" UUID;

-- CreateTable
CREATE TABLE "crm_workspace_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" "crm_binding_status" NOT NULL DEFAULT 'active',
    "chart_template" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_workspace_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_service_credentials" (
    "id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "crm_credential_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "crm_service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_posting_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_posting_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subledger_parties" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "source_system" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subledger_parties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_workspace_bindings_workspace_id_key" ON "crm_workspace_bindings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_workspace_bindings_tenant_id_key" ON "crm_workspace_bindings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_workspace_bindings_company_id_key" ON "crm_workspace_bindings"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_service_credentials_token_hash_key" ON "crm_service_credentials"("token_hash");

-- CreateIndex
CREATE INDEX "crm_service_credentials_binding_id_idx" ON "crm_service_credentials"("binding_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_posting_profiles_company_id_role_key" ON "crm_posting_profiles"("company_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "subledger_parties_company_id_source_system_external_ref_key" ON "subledger_parties"("company_id", "source_system", "external_ref");

-- CreateIndex
CREATE INDEX "journal_lines_party_id_idx" ON "journal_lines"("party_id");

-- AddForeignKey
ALTER TABLE "crm_workspace_bindings" ADD CONSTRAINT "crm_workspace_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_workspace_bindings" ADD CONSTRAINT "crm_workspace_bindings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_service_credentials" ADD CONSTRAINT "crm_service_credentials_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "crm_workspace_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_posting_profiles" ADD CONSTRAINT "crm_posting_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_posting_profiles" ADD CONSTRAINT "crm_posting_profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subledger_parties" ADD CONSTRAINT "subledger_parties_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "subledger_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hosted CRM workspaces: additive only. Existing tenants, companies, accounts and journals are
-- left as they are; existing journal lines keep party_id NULL.
ALTER TABLE "crm_posting_profiles" ADD CONSTRAINT "crm_posting_profiles_role_check"
  CHECK ("role" IN ('receivable', 'revenue', 'sales_returns', 'receipts_clearing', 'tax_payable', 'opening_equity', 'adjustments'));
ALTER TABLE "subledger_parties" ADD CONSTRAINT "subledger_parties_kind_check"
  CHECK ("kind" IN ('company', 'individual'));
ALTER TABLE "subledger_parties" ADD CONSTRAINT "subledger_parties_external_ref_check"
  CHECK (char_length("external_ref") BETWEEN 1 AND 64);
