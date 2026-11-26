# Nexera ERP

Nexera is a multi-tenant accounting workspace for restaurant groups. Each company has its own accounts, fiscal periods, journal numbering, and trial balance.

## Local development

Use Node 24 and Docker Compose.

1. Run `npm ci` to install the workspaces and generate the Prisma client.
2. Copy `.env.example` to `.env` and set `NEXERA_OWNER_PASSWORD` to a local password of at least 10 characters.
3. Start PostgreSQL with `npm run infra:up`.
4. Run `npm run db:setup` to apply the migrations and create the local demo tenant. The seed command preserves existing tenants and rejects a duplicate slug.
5. Run `npm run dev` and open the URL printed by Vite. Choose **Sign in** and use tenant `easyoffice`, email `owner@example.com`, and the password you set.

Run `npm run dev:web` for the browser-only demo. Its sample data and drafts are stored in the browser. The signed-in workspace starts with a starter chart and twelve fiscal periods for each provisioned company. Post a balanced journal to populate the overview and trial balance.

To provision a different tenant, apply the migrations, supply the owner's password through `NEXERA_OWNER_PASSWORD`, and run the following command with your tenant and company details. The final argument is the fiscal year to provision.

```sh
npm run tenant:create -- restaurant "Restaurant Group" owner@example.com "Finance Owner" "Restaurant Company" "شركة المطعم" CR1234 2026
```

## Checks

`npm run check` checks formatting, lint, types, tests, and both production builds. The PostgreSQL integration tests run when `NEXERA_TEST_DATABASE_URL` points to a dedicated test database with the migrations applied. The suite creates test tenants in that database.

The current accounting workflow covers viewing companies, periods and accounts, creating and editing journal drafts, posting, reversals, and the trial balance. Company, chart-of-accounts and fiscal-year provisioning is currently CLI-based. The [phase plan](docs/phase1-design.md) covers future administration, integrations, reporting, and Qayd XBRL.
