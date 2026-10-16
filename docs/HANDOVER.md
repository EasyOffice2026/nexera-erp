# Handover: nexera-erp

Start here when continuing this project in a new Devin session.

## What this is

A new, standalone, **multi-tenant SaaS** for restaurant groups (sold to other restaurants too):
accounting linked to everything + the Kuwait Ministry of Commerce **Qayd XBRL** filing.
It is completely separate from the live Mudawwarah system (`EasyOffice2026/accounting-saas`,
https://mudawwarah.nexerakw.com/). Do not change that system or its database from this project.

- Full product plan: `docs/platform-plan.md`
- Phase 1 design (approved direction): `docs/phase1-design.md`

## Decisions already taken by the owner (Javed)

| Topic                      | Decision                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                       | New standalone repo `EasyOffice2026/nexera-erp`                                                                                                                                                                                                   |
| Product                    | Multi-tenant SaaS (tenant → company/legal entity → brand → branch)                                                                                                                                                                                |
| First phase                | Accounting + XBRL                                                                                                                                                                                                                                 |
| Stack                      | TypeScript/Node + PostgreSQL, same conventions as the POS (`EasyOffice2026/POS_System`) so its developer can work on it too: Express 5, Prisma 7 (`@prisma/adapter-pg`), zod 4, jose, vitest, React 19 + Vite + Tailwind 4 + i18next (EN/AR, RTL) |
| Mudawwarah / Khubuz Maraei | **Two separate companies** (two CRs, two Qayd filings), financial year-end **31 Dec**                                                                                                                                                             |
| POS                        | Built by the owner's own developer in `EasyOffice2026/POS_System`. Do not rebuild it; integrate through an events API                                                                                                                             |
| Website                    | Already done (`EasyOffice2026/Mudawwrah-website`); WhatsApp agent in `EasyOffice2026/mudawwarah-voice-agent`. Integrate via API, no shared database                                                                                               |

## Qayd / XBRL facts (researched Oct 2026)

- Portal qayd.moci.gov.kw opened Apr 2026; voluntary in 2026, **mandatory from 1 Jan 2027** for all companies (WLL, single-person, partnership, KSC).
- IFRS statements in XBRL, within 6 months of year-end, signed by a licensed auditor. Fines KD 5,000–50,000.
- Final MOCI taxonomy/technical manual not confirmed published. Build against the IFRS taxonomy with configurable mapping (`Account.taxonomyConcept`), switch to Qayd's when released. Validate with Arelle.

## State of the code (M1: ledger foundations)

Done:

- Monorepo: `apps/api`, `apps/web`, `packages/shared` (zod schemas/types, exact money in fils).
- Database: first migration `apps/api/prisma/migrations/20261016155551_init`. `company.journal_seq`
  holds the last posted journal number; incrementing it locks the company row, so posting,
  reversing and closing periods of one company run one at a time.
- API (`/api/v1`, all tenant-scoped, permissions from `packages/shared/src/auth.ts`):
  - `auth`, `users`, `health` (from the scaffold).
  - `companies`: companies, brands, branches. `useTemplate` (default on) seeds the bilingual
    IFRS restaurant chart of accounts (`modules/companies/chart-template.ts`) with
    `ifrs-full:` taxonomy concepts.
  - `accounts`: list, create, update, delete. Parent must be a header of the same type; used
    accounts and headers with children cannot be deleted or made non-postable/postable.
  - `periods`: fiscal year of 12 monthly periods (must start the month after the company's
    year-end month), close/reopen; a period with draft journals cannot close.
  - `journals`: drafts (may be unbalanced, but dated in an open period, with active postable
    accounts and active branches of the company); post (>= 2 lines, debit = credit, next number);
    reverse (posted reversal with swapped lines, linked both ways). Posted journals never change.
  - `reports`: trial balance (opening / movement / closing), account ledger with running
    balance, income statement and balance sheet by subtype; branch and brand filters.
- `prisma/seed.ts`: demo tenant `easyoffice` with Mudawwarah and Khubuz Maraei (separate
  companies), brands, branches, FY2026 and a few posted journals; one user per role.
- `prisma/create-tenant.ts`: `npm run tenant:create -- --slug … --name … --email … --full-name …`.
- API tests (`apps/api/test`, supertest on a real Postgres schema `nexera_test`).
- Web app (React 19 + Vite + Tailwind 4, EN/AR with RTL): sign-in, company switcher, companies
  with brands/branches, chart of accounts tree, journals list/entry/post/reverse, periods,
  trial balance, income statement, balance sheet, account ledger.
- CI (`.github/workflows/ci.yml`), `Dockerfile` (one image; the API serves the web app and runs
  migrations on start), `README.md`.

Next milestones: integration API + posting rules for POS/website/WhatsApp events (M2), AR/AP,
banks, fixed assets, EOSB, IFRS 16 leases, period close (M3), statements + Excel/Arabic PDF
auditor pack (M4), XBRL generator + validation (M5). See `docs/phase1-design.md` §8.

## Local setup

```bash
nvm use 24            # Node >= 24 required (.nvmrc)
npm install           # also runs prisma generate
npm run infra:up      # Postgres 17 on localhost:5432 (docker-compose.yml)
cp .env.example .env
npm run db:setup      # migrations + demo data (tenant easyoffice, password DevPassw0rd!)
npm run dev           # API on :3000, web on :5173
```

Docker Hub may rate-limit pulls; `docker pull mirror.gcr.io/library/postgres:17` and tag it
`postgres:17` if `infra:up` fails with 429.

## Owner answers

- Both companies started operations in 2026, so FY2026 is their first report. There are no
  earlier audited statements; opening balances are the capital introduced.
- Deploy on Fly.io with PostgreSQL on Supabase (a project of its own). Demo: app
  `nexera-erp` (region `sin`), https://nexera-erp.fly.dev/, demo tenant loaded with `npm run db:seed`.
