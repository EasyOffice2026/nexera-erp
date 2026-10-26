# Nexera ERP

Multi-tenant accounting for restaurant groups, linked to their operations (POS, website,
WhatsApp) and to the Kuwait Ministry of Commerce Qayd XBRL filing. Bilingual English / Arabic,
amounts in KWD to the fils.

Start with [docs/HANDOVER.md](docs/HANDOVER.md) (decisions, state, next steps) and
[docs/phase1-design.md](docs/phase1-design.md) (tenancy, chart of accounts, posting rules).

## CRM accounting connector

CRM stays a separate one-company application with its own login. The CRM backend can read this
ERP organization's mapped legal-company accounting without exposing an ERP password or token to
the browser. This connector currently supports **KWD** only.

- Provision/rotate: `POST /api/v1/companies/:companyId/crm-integration`, using a normal ERP
  access token with `integrations.manage` permission. The response is `no-store` and returns a
  random service token **once**. Store it in the CRM server's secret configuration, never in Git.
  Rotating invalidates the old credential while keeping the integration identity/idempotency namespace.
- Service authentication: `Authorization: Bearer <service token>`. Only its SHA-256 hash is stored.
  The integration, organization, company and provisioning user must remain active and authorized.
  Request parameters cannot select another company/tenant.
- Read endpoints under `/api/v1/integrations/crm`: `GET /connection`, `/accounts`, `/journals`
  and `/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD`. Normal journal pagination and report dates apply.
- Posting: `POST /api/v1/integrations/crm/journals`, with `currency: "KWD"`, a stable `externalId`,
  `date`, `description`, optional `reference` and journal `lines` (accountId, optional branchId,
  description, debit, credit). Identical retries return the same journal. Reusing an external ID
  with different content returns `409 CRM_EVENT_CONFLICT`; amounts are normalized to fils precision.
  Posting uses existing company locks, open-period checks, account/branch scope, reconciliation
  locks, numbering and audit rules. Concurrent retries create only one journal.

`CRM_INTEGRATION_POSTING_ENABLED` defaults to **false**. Reconcile historical balances and confirm
the company/account mapping in CRM before enabling it and CRM's separate `CRM_ERP_SYNC_ENABLED`
flag. Neither migrations nor provisioning post/import historical financial data. Never enable live
posting merely to preview the UI. The companion CRM implementation is in
[crm-system](https://github.com/EasyOffice2026/crm-system/pull/1).

### Hosted CRM workspaces (staging/local only)

Each hosted CRM workspace gets its own ERP tenant and legal company, the `general_business_v1`
chart, a 12-period fiscal year and CRM posting profiles (receivable 1210, revenue 4100, sales
returns 4900, receipts clearing 1150, tax payable 2300, opening equity 3900, adjustments 4950).
No ERP user or password is created. Customers are kept in a subledger (`subledger_parties`,
`journal_lines.party_id`) under the single receivable control account.

- Provider API `/api/v1/platform/crm-workspaces/:workspaceId` (`PUT`, `GET`, `POST .../suspend`,
  `POST .../resume`, `PUT|DELETE .../credentials/:credentialId` with `{ "tokenSha256" }`), bearer
  `nxp_<keyId>_<secret>` checked against `PLATFORM_API_KEYS`; no browsers, rate limited, audited.
- The CRM backend calls `/api/v1/integrations/crm` with `Authorization: Bearer nxc_...` and
  `X-Crm-Workspace-Id`. It reads `/connection`, `/accounts`, `/journals`, `/trial-balance`,
  `/customers/:ref/balance`, `/receivables`, and posts only through `POST /events`
  (`Idempotency-Key` = `eventId`; one journal per workspace and event, replays return
  `duplicate: true`, changed content `409 CRM_EVENT_CONFLICT`, posting off `403 POSTING_DISABLED`).

`PLATFORM_PROVISIONING_ENABLED` and `CRM_INTEGRATION_POSTING_ENABLED` stay **false** in production.

## Structure

| Path              | What                                                            |
| ----------------- | --------------------------------------------------------------- |
| `apps/api`        | Express 5 + Prisma 7 API (`/api/v1`), PostgreSQL                |
| `apps/web`        | React 19 + Vite web app, EN/AR with RTL                         |
| `packages/shared` | Schemas and types shared by both, exact money helpers (in fils) |

## Run locally

Needs Node 24 (`.nvmrc`) and Docker.

```bash
npm install
npm run infra:up      # PostgreSQL 17 on localhost:5432
cp .env.example .env
npm run db:setup      # migrations + demo data
npm run dev           # API http://localhost:3000, web http://localhost:5173
```

Demo sign-in: organisation `easyoffice`, email `owner@easyoffice.test` (also
`finance.manager@`, `accountant@`, `auditor@`), password `DevPassw0rd!`.

## Checks

```bash
npm run check         # format, lint, typecheck, tests (needs the database), build
```

## Production

`docker build -t nexera-erp .` makes one image: the API serves the web app and runs the
migrations when it starts. It needs `DATABASE_URL` and `JWT_ACCESS_SECRET` (32+ random
characters); see `.env.example`. Create each customer with
`npm run tenant:create -- --slug <slug> --name <name> --email <email> --full-name <name>`.

On Fly.io (`fly.toml`): set `DATABASE_URL` and `JWT_ACCESS_SECRET` with `flyctl secrets set`, then
`flyctl deploy --remote-only`. To load the demo tenant into a demo database, run
`DATABASE_URL=... DEMO_PASSWORD=... npm run db:seed -w @nexera/api` from your machine.
