# Nexera ERP

Multi-tenant accounting for restaurant groups, linked to their operations (POS, website,
WhatsApp) and to the Kuwait Ministry of Commerce Qayd XBRL filing. Bilingual English / Arabic,
amounts in KWD to the fils.

Start with [docs/HANDOVER.md](docs/HANDOVER.md) (decisions, state, next steps) and
[docs/phase1-design.md](docs/phase1-design.md) (tenancy, chart of accounts, posting rules).

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
