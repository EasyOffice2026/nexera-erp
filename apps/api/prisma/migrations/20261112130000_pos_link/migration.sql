-- The link with the restaurants' POS (docs/unified-platform.md).

-- CreateTable
CREATE TABLE "pos_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "api_url" TEXT NOT NULL,
    "web_url" TEXT NOT NULL,
    "key_ciphertext" TEXT NOT NULL,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_branch_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pos_branch_id" UUID NOT NULL,
    "pos_brand_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_branch_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "pos_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "amount" DECIMAL(15,3) NOT NULL,
    "journal_entry_id" UUID,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_connections_tenant_id_key" ON "pos_connections"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_branch_links_tenant_id_pos_branch_id_key" ON "pos_branch_links"("tenant_id", "pos_branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_accounts_company_id_role_key" ON "pos_accounts"("company_id", "role");

-- CreateIndex
CREATE INDEX "pos_documents_tenant_id_business_date_idx" ON "pos_documents"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "pos_documents_company_id_external_id_key" ON "pos_documents"("company_id", "external_id");
