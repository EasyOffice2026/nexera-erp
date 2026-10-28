ALTER TABLE "journal_entries" ADD COLUMN "crm_payload_hash" TEXT;

CREATE TABLE "crm_integrations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_integrations_company_id_key" ON "crm_integrations"("company_id");
CREATE UNIQUE INDEX "crm_integrations_token_hash_key" ON "crm_integrations"("token_hash");

ALTER TABLE "crm_integrations" ADD CONSTRAINT "crm_integrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_integrations" ADD CONSTRAINT "crm_integrations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_integrations" ADD CONSTRAINT "crm_integrations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
